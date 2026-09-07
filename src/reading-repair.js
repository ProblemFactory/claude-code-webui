'use strict';
// READINGS-BY-SLOT DATA REPAIR (2026-09-07) — the root-cause cleanup for the
// entries the refuted attribution rule wrote.
//
// WHAT WENT WRONG. Every VALUE reading was keyed by the OTel-observed org =
// the identity the CLI cached in its config dir at SPAWN. A pool hot switch
// re-points the credential link and the running CLI re-reads it, so after any
// switch a session's readings were filed under the account it STARTED on. On
// this instance the visible symptom was a member whose login was WIPED on
// 2026-09-03T05:55Z still receiving limit-banner marks and Fable-bucket
// readings on 09-07 — five days of another account's numbers. The silent
// symptom is worse and has no visible tell: between two logged-in members the
// numbers simply land on the wrong one, poisoning both panels, both anchor
// streams and the learned rates.
//
// WHAT WE CAN PROVE, AFTERWARDS. Three evidence sources, in strength order:
//   ① the SLOT-TRANSITION LEDGER (data/slot-transitions.jsonl) — exact, but it
//      starts empty with this release, so it can only speak for entries
//      written from now on (and for anything backfilled, see ③). Used first
//      wherever an entry names a session.
//   ② each member's LAST-KNOWN-GOOD marker (src/login-state.js): a credential
//      file that is wiped/expired records WHEN it stopped being able to
//      produce anything. An entry filed on that member with a later timestamp
//      is PROVABLY foreign — no inference, no heuristic.
//   ③ an operator-provided frozen journal (`data/pool-journal.log`, or any
//      data/archive/pool-journal*.log): the engine's own
//      "[pool] per-session switch <pool>/<sid>: <from> → <to>" and
//      "[pool] auto-switch <pool>: <from> → <to>" lines, backfilled into ①.
//      Optional by construction — journalctl is not readable at boot.
//
// RULES. Archive, never destroy (data/archive/…); every archived entry carries
// a REASON; an entry that cannot be re-attributed is archived rather than
// silently kept; idempotent (a second run finds nothing left to do) and
// restart-safe (each store is rewritten atomically, tmp+rename).
const fs = require('fs');
const path = require('path');
const { accountLoginState } = require('./login-state.js');

function _readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; } }
function _writeAtomic(f, text) { fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f); }
function _appendArchive(archiveDir, name, rows) {
  if (!rows.length) return;
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.appendFileSync(path.join(archiveDir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** members: [{id, credsPath, backend, oatMintedAt}] → Map(id → {state, since})
 *  for every member that CANNOT produce a reading and can say since when. A
 *  live login, or a dead one with no recoverable instant, contributes nothing:
 *  this migration only ever acts on proof.
 *
 *  THE QUESTION IS THE ACCOUNT'S, NOT THE FILE'S (2026-09-07 r2, reproduced):
 *  a claude subscription whose local credential dir is wiped but which holds a
 *  valid LONG-LIVED TOKEN (B-211a) is a supported, spawnable, reading-PRODUCING
 *  configuration — `resolveForSpawn` returns `{oatOnly:true, localEnv:
 *  {CLAUDE_CODE_OAUTH_TOKEN}}` and the session still carries `_accountId =
 *  sub-X`, so its readings legitimately land on usage-cache/sub-X.json. Dating
 *  its "death" from the wipe would archive every one of them: measured on a
 *  fixture (creds wiped 5d ago, valid oat, one 1h-old reading) the panel was
 *  rewound to a 6-day-old snapshot, the fresh anchor dropped and the
 *  instance-wide rates.json deleted. `accountLoginState` asks BOTH channels;
 *  the caller supplies `oatMintedAt` from accounts.json (no decryption — the
 *  token's value is irrelevant to "was it alive then"). */
function deathMarkers(members, { now = Date.now() } = {}) {
  const out = new Map();
  for (const m of members || []) {
    if (!m || !m.id || !m.credsPath) continue;
    const st = accountLoginState(m.credsPath, { now, backend: m.backend || 'claude', oatMintedAt: m.oatMintedAt || null });
    if (st.usable) continue;
    if (!st.since) continue; // dead but undateable ⇒ we can prove nothing about any entry
    out.set(m.id, { state: st.state, since: st.since });
  }
  return out;
}

/** Foreign iff we have a marker for this key AND the entry is newer than the
 *  instant that key stopped being able to produce anything. */
function isForeign(markers, key, ts) {
  const m = key && markers.get(key);
  return !!(m && Number(ts) > m.since);
}

// ── ③ journal backfill ───────────────────────────────────────────────────────
const SWITCH_RE = /\[pool\]\s+per-session switch\s+(\S+)\/(\S+):\s+(\S+?)(?:\s+\([^)]*\))?\s+→\s+(sub-[\w-]+)/;
const POOL_RE = /\[pool\]\s+auto-switch\s+(\S+):\s+(\S+)\s+→\s+(sub-[\w-]+)/;
/** journalctl/syslog prefixes we can date. Anything else is skipped and
 *  COUNTED — a line we cannot place in time is not evidence. */
function _lineTs(line) {
  let m = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(line);
  if (m) { const t = Date.parse(m[1]); if (Number.isFinite(t)) return t; }
  // syslog "Sep 07 18:55:36" — no year; assume the most recent occurrence
  m = /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/.exec(line);
  if (m) {
    const now = new Date();
    const t = Date.parse(`${m[1]} ${now.getUTCFullYear()}`);
    if (Number.isFinite(t)) return t > now.getTime() + 86400e3 ? Date.parse(`${m[1]} ${now.getUTCFullYear() - 1}`) : t;
  }
  return null;
}
function backfillFromJournal(text, transitions) {
  const res = { lines: 0, undated: 0, recorded: 0 };
  for (const line of String(text || '').split('\n')) {
    const s = SWITCH_RE.exec(line);
    const p = s ? null : POOL_RE.exec(line);
    if (!s && !p) continue;
    res.lines++;
    const at = _lineTs(line);
    if (!at) { res.undated++; continue; }
    const row = s
      ? { sessionId: s[2], poolId: s[1], from: s[3], to: s[4], at, why: 'journal-backfill' }
      : { sessionId: null, poolId: p[1], from: p[2], to: p[3], at, why: 'journal-backfill' };
    if (transitions.record(row)) res.recorded++;
  }
  return res;
}

// ── ② usage-cache repair ────────────────────────────────────────────────────
const IDENTITY_FIELDS = ['orgUuid', 'orgName', 'orgEmail', 'email', 'name'];
/** Rebuild a cache snapshot from a surviving anchor (a REAL past reading of
 *  this account, correctly dated) — identity fields are carried over because
 *  they are facts about WHO the account is, not readings. */
function _cacheFromAnchor(anchor, prev) {
  const out = {};
  for (const k of IDENTITY_FIELDS) if (prev && prev[k] !== undefined) out[k] = prev[k];
  const b = anchor.buckets || {};
  if (b.fiveHour) out.fiveHour = { utilization: b.fiveHour.u, resetsAt: b.fiveHour.resetsAt || 0, status: 'allowed' };
  if (b.sevenDay) out.sevenDay = { utilization: b.sevenDay.u, resetsAt: b.sevenDay.resetsAt || 0, status: 'allowed' };
  if (Array.isArray(b.scopedWeekly) && b.scopedWeekly.length) {
    out.scopedWeekly = b.scopedWeekly.map((s) => ({ name: s.name, utilization: s.u, resetsAt: s.resetsAt || 0 }));
    const asOf = b.scopedWeekly.find((s) => s.asOf)?.asOf;
    if (asOf) out.scopedFetchedAt = asOf;
  }
  out.fetchedAt = anchor.fetchedAt;
  out.source = anchor.source || 'unknown';
  return out;
}

/** Every anchor record across every anchors-*.ndjson (used both for the repair
 *  and to find a surviving reading to restore a cache from). */
function _readAnchorFiles(anchorsDir) {
  const files = [];
  let names = [];
  try { names = fs.readdirSync(anchorsDir).filter((f) => /^anchors-.*\.ndjson$/.test(f)); } catch { return files; }
  for (const fn of names) {
    const fp = path.join(anchorsDir, fn);
    let txt = ''; try { txt = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    const rows = [];
    for (const line of txt.split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      rows.push(r);
    }
    files.push({ file: fp, name: fn, rows });
  }
  return files;
}

function repairUsageCaches({ cacheDir, archiveDir, markers, anchorFiles, id }) {
  const res = { scanned: 0, foreign: 0, restored: 0, blanked: 0 };
  let names = [];
  try { names = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json') && f !== '__models__.json'); } catch { return res; }
  for (const fn of names) {
    const key = fn.slice(0, -5);
    const marker = markers.get(key);
    if (!marker) continue;
    const fp = path.join(cacheDir, fn);
    const cur = _readJson(fp);
    if (!cur || typeof cur.fetchedAt !== 'number') continue;
    res.scanned++;
    if (!isForeign(markers, key, cur.fetchedAt)) continue;
    res.foreign++;
    _appendArchive(archiveDir, 'readings-foreign-usage-cache.ndjson', [{
      migration: id, at: Date.now(), store: 'usage-cache', key,
      reason: `written ${new Date(cur.fetchedAt).toISOString()}, after this account's login was ${marker.state} at ${new Date(marker.since).toISOString()}`,
      entry: cur,
    }]);
    // Restore the newest anchor of this account that predates the death — a
    // real past reading, correctly dated. There is no way to RE-ATTRIBUTE the
    // foreign snapshot (a cache file records no session), so it is archived.
    let best = null;
    for (const f of anchorFiles) {
      for (const r of f.rows) {
        if (!r || (r.accountId ?? '__global__') !== key) continue;
        if (!(Number(r.fetchedAt) > 0) || r.fetchedAt > marker.since) continue;
        if (!best || r.fetchedAt > best.fetchedAt) best = r;
      }
    }
    if (best) { _writeAtomic(fp, JSON.stringify(_cacheFromAnchor(best, cur))); res.restored++; }
    else {
      // identity only: no bucket, no fetchedAt ⇒ nothing claims to be a reading
      const remnant = {};
      for (const k of IDENTITY_FIELDS) if (cur[k] !== undefined) remnant[k] = cur[k];
      remnant.repairedBy = id; remnant.staleSince = marker.since;
      _writeAtomic(fp, JSON.stringify(remnant)); res.blanked++;
    }
  }
  return res;
}

// ── ② anchors repair (+ the estimator's learning chain) ─────────────────────
function repairAnchors({ anchorsDir, archiveDir, markers, anchorFiles, id }) {
  const res = { files: 0, dropped: 0, voided: 0 };
  for (const f of anchorFiles) {
    const keep = [], drop = [];
    for (const r of f.rows) {
      if (isForeign(markers, r.accountId ?? '__global__', r.fetchedAt)) drop.push(r); else keep.push(r);
    }
    if (!drop.length) continue;
    res.files++; res.dropped += drop.length;
    const marks = drop.map((r) => ({
      migration: id, at: Date.now(), store: 'usage-anchors', file: f.name,
      reason: `anchor of ${r.accountId || '__global__'} recorded ${new Date(r.fetchedAt).toISOString()}, after that login was ${markers.get(r.accountId ?? '__global__').state} at ${new Date(markers.get(r.accountId ?? '__global__').since).toISOString()}`,
      entry: r,
    }));
    _appendArchive(archiveDir, 'readings-foreign-anchors.ndjson', marks);
    // Re-chain: the record FOLLOWING a removed one has a dangling
    // prevFetchedAt and a costSince measured over an interval whose endpoint
    // we just deleted. Rewire prevFetchedAt to the surviving predecessor and
    // VOID costSince — extractPairs already skips a record with no costSince,
    // so nothing learns from an interval we can no longer cost. (Voiding is
    // the honest move: the cost is real, the Δu is not.)
    keep.sort((a, b) => (a.fetchedAt || 0) - (b.fetchedAt || 0));
    const dropped = new Set(drop.map((r) => r.fetchedAt));
    for (let i = 0; i < keep.length; i++) {
      const r = keep[i];
      if (r.prevFetchedAt == null || !dropped.has(r.prevFetchedAt)) continue;
      const prev = i > 0 ? keep[i - 1] : null;
      r.prevFetchedAt = prev ? prev.fetchedAt : null;
      r.elapsedSec = prev ? Math.round((r.fetchedAt - prev.fetchedAt) / 1000) : null;
      r.costSince = null;
      r.repairedBy = id;
      res.voided++;
    }
    _writeAtomic(f.file, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
    f.rows = keep;
  }
  // The learned rates are DERIVED from the pairs we just changed — archive the
  // snapshot and drop it so the estimator re-learns from the cleaned anchors.
  if (res.dropped) {
    const rates = path.join(anchorsDir, 'rates.json');
    const cur = _readJson(rates);
    if (cur) {
      _appendArchive(archiveDir, 'readings-foreign-rates.ndjson', [{ migration: id, at: Date.now(), store: 'usage-anchors/rates.json', reason: 'learned from anchors that included foreign readings — re-learned from the cleaned set', entry: cur }]);
      try { fs.unlinkSync(rates); } catch { }
      res.ratesReset = true;
    }
  }
  return res;
}

// ── ① + ② attribution repair (the only store whose entries NAME a session) ──
function repairAttribution({ historyDir, archiveDir, markers, transitions, id }) {
  const res = { scanned: 0, foreign: 0, reattributed: 0, archived: 0, emptied: 0 };
  const fp = path.join(historyDir, 'attribution.ndjson');
  let txt = ''; try { txt = fs.readFileSync(fp, 'utf-8'); } catch { return res; }
  const out = [], archived = [];
  // Which conversations LOSE their last entry here (2026-09-07 r2) — see the
  // note at the re-bake hand-off below.
  const sidsBefore = new Set(), sidsKept = new Set();
  let dirty = false;
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { out.push(line); continue; }
    res.scanned++;
    if (r.sid) sidsBefore.add(r.sid);
    if (!isForeign(markers, r.acct, r.ts)) { out.push(line); if (r.sid) sidsKept.add(r.sid); continue; }
    res.foreign++;
    const m = markers.get(r.acct);
    // ① the transition ledger is the ONLY thing that can say where this
    // conversation really was at that instant. Present (or backfilled from a
    // journal) ⇒ re-attribute; absent ⇒ archive, which makes the by-time walk
    // fall back to this session's previous, un-refuted entry.
    const slot = transitions ? transitions.slotAt(r.sid, r.ts, { poolId: r.pool || null }) : null;
    if (slot && slot.id && slot.id !== r.acct && !isForeign(markers, slot.id, r.ts)) {
      archived.push({ migration: id, at: Date.now(), store: 'attribution', reason: `re-attributed to ${slot.id} (slot transition at ${new Date(slot.at).toISOString()}, scope ${slot.scope})`, entry: r });
      out.push(JSON.stringify({ ...r, acct: slot.id, repairedBy: id }));
      if (r.sid) sidsKept.add(r.sid);
      res.reattributed++; dirty = true;
      continue;
    }
    archived.push({ migration: id, at: Date.now(), store: 'attribution', reason: `attributed to ${r.acct} at ${new Date(r.ts).toISOString()}, after that login was ${m.state} at ${new Date(m.since).toISOString()}; no slot transition on record ⇒ cannot re-attribute`, entry: r });
    res.archived++; dirty = true;
  }
  if (dirty) {
    _appendArchive(archiveDir, 'readings-foreign-attribution.ndjson', archived);
    _writeAtomic(fp, out.join('\n') + (out.length ? '\n' : ''));
    // HAND-OFF TO THE RE-BAKE. The baked ledger events carry the acct this
    // walk produced, so clearing the one-shot marker makes UsageHistory's own
    // re-bake recompute them from the cleaned walk on the next scan.
    // …EXCEPT for a conversation whose entries were ALL archived (2026-09-07
    // r2, reproduced): the re-bake only recomputes `if (e.sid && attrib[e.sid])`
    // — a deliberate rule from when the baked value came from the WALK ("for
    // sids without any, the baked value is the only record we have"). After
    // this repair that is no longer true: those events carry the value the
    // REFUTED attribution wrote, and the sid is now absent from the map, so
    // they would keep the dead account forever. Such sids exist by
    // construction — the old OTel corrective record fired whenever the
    // observation disagreed with `attribAt`, which answers acct:null for a sid
    // with no entries, so a conversation's FIRST and only entry could be a
    // corrective one. Name them for the re-bake; `_acctAt` then falls back to
    // session-meta (the pool/account the session was created with — a fact we
    // still hold), which is exactly the un-refuted answer.
    // The list is APPENDED and kept: it stays true (those sids have no
    // attribution entries), so any later re-bake generation inherits it.
    const emptied = [...sidsBefore].filter((sid) => !sidsKept.has(sid));
    res.emptied = emptied.length;
    if (emptied.length) {
      const f = path.join(historyDir, '.attrib-emptied.json');
      const prev = _readJson(f);
      const merged = [...new Set([...(Array.isArray(prev) ? prev : []), ...emptied])].slice(-20000);
      try { _writeAtomic(f, JSON.stringify(merged)); } catch { }
    }
    try { fs.unlinkSync(path.join(historyDir, '.attrib-rebake-v1')); } catch { }
  }
  return res;
}

/** THE repair. Pure orchestration over the four stores; returns a report the
 *  migration logs. Never throws on a missing store — an instance that has
 *  never pooled has nothing to repair. */
function repairReadings({ dataDir, members, transitions, id = 'readings-by-slot', now = Date.now(), journalText = null }) {
  const archiveDir = path.join(dataDir, 'archive');
  const report = { id, at: now, journal: null, markers: [], caches: null, anchors: null, attribution: null };
  if (journalText && transitions) report.journal = backfillFromJournal(journalText, transitions);
  const markers = deathMarkers(members, { now });
  report.markers = [...markers].map(([k, v]) => ({ key: k, state: v.state, since: v.since }));
  const anchorsDir = path.join(dataDir, 'usage-anchors');
  const anchorFiles = _readAnchorFiles(anchorsDir);
  if (markers.size) {
    report.caches = repairUsageCaches({ cacheDir: path.join(dataDir, 'usage-cache'), archiveDir, markers, anchorFiles, id });
    report.anchors = repairAnchors({ anchorsDir, archiveDir, markers, anchorFiles, id });
  }
  report.attribution = repairAttribution({ historyDir: path.join(dataDir, 'usage-history'), archiveDir, markers, transitions, id });
  return report;
}

/** The optional frozen journal an operator can drop in (journalctl is not
 *  readable from a boot migration). First match wins. */
function findJournal(dataDir) {
  const cands = [path.join(dataDir, 'pool-journal.log')];
  try {
    for (const f of fs.readdirSync(path.join(dataDir, 'archive'))) {
      if (/^pool-journal.*\.log$/.test(f)) cands.push(path.join(dataDir, 'archive', f));
    }
  } catch { }
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch { } }
  return null;
}

module.exports = { repairReadings, deathMarkers, isForeign, backfillFromJournal, findJournal, repairUsageCaches, repairAnchors, repairAttribution };
