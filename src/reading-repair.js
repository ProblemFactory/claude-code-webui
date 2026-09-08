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
    // `s[2]` is the WEBUI session key — usage-pool-engine prints the
    // activeSessions loop key ("[pool] per-session switch <pool>/<webuiId>"),
    // which is the same namespace ensureSessionPoolLink records under. That
    // agreement is why the r3 join lives at the READ side (repairAttribution)
    // rather than here: every writer already speaks webui keys, only the
    // attribution log speaks conversation ids.
    const row = s
      ? { sessionId: s[2], poolId: s[1], from: s[3], to: s[4], at, why: 'journal-backfill' }
      : { sessionId: null, poolId: p[1], from: p[2], to: p[3], at, why: 'journal-backfill' };
    if (transitions.record(row)) res.recorded++;
  }
  return res;
}

// ── ② usage-cache repair ────────────────────────────────────────────────────
// The established window is NOT in this list, and not in the snapshot at all
// (r2): it is a fact about WHO the account is, which is exactly why it may not
// live in the object every reading producer rewrites. It has its own sidecar —
// see windowSidecarName in src/reading-lag.js.
const IDENTITY_FIELDS = ['orgUuid', 'orgName', 'orgEmail', 'email', 'name'];
/** Rebuild a cache snapshot from a surviving anchor (a REAL past reading of
 *  this account, correctly dated) — identity fields are carried over because
 *  they are facts about WHO the account is, not readings.
 *
 *  `window` (r4) = the account's OWN established window, when the caller has
 *  one. Every bucket it can judge must AGREE with it or it does not go into
 *  this account's cache: `accountRemaining`, `weeklyDeadline` and `bucketRems`
 *  all read `cache.scopedWeekly`, so writing another member's model-scoped
 *  bucket here is a misattributed reading that can flip a pool switch — the
 *  2.305.0 class. Omitted (the by-slot repair has no window to check against)
 *  ⇒ nothing is filtered, exactly as before. */
function _cacheFromAnchor(anchor, prev, window = null) {
  const out = {};
  for (const k of IDENTITY_FIELDS) if (prev && prev[k] !== undefined) out[k] = prev[k];
  const b = anchor.buckets || {};
  const own = (name) => (window && window.scoped ? window.scoped[String(name || '').toLowerCase()] : null);
  const agrees = (resetsAt, phase) => !window || phase == null || !(Number(resetsAt) > 0) || weeklyNear(resetsAt, phase) !== false;
  if (b.fiveHour) out.fiveHour = { utilization: b.fiveHour.u, resetsAt: b.fiveHour.resetsAt || 0, status: 'allowed' };
  if (b.sevenDay && agrees(b.sevenDay.resetsAt, window && window.sevenDay)) out.sevenDay = { utilization: b.sevenDay.u, resetsAt: b.sevenDay.resetsAt || 0, status: 'allowed' };
  const sw = (Array.isArray(b.scopedWeekly) ? b.scopedWeekly : []).filter((s) => s && agrees(s.resetsAt, own(s.name)));
  if (sw.length) {
    out.scopedWeekly = sw.map((s) => ({ name: s.name, utilization: s.u, resetsAt: s.resetsAt || 0 }));
    const asOf = sw.find((s) => s.asOf)?.asOf;
    if (asOf) out.scopedFetchedAt = asOf;
  } else if (window && Array.isArray(prev && prev.scopedWeekly)) {
    // NEVER CLOBBER A KNOWN SCOPED BUCKET WITH AN EMPTY ANSWER (r4). Scoped
    // buckets only ever come from the panel, so most anchors state none — and
    // once the per-bucket move can leave the newest own-window record without
    // one, a rebuild that simply replaces the snapshot DELETES the account's
    // model cap from the object the pool reads. That is the 2.70.0
    // Fable-vanishing class, which is exactly why all three live writers
    // preserve-merge this field; the rebuild now does the same, filtered by the
    // account's own window so the preserve can never carry a foreign bucket
    // forward. Only when a `window` is supplied: `repairUsageCaches` (the
    // by-slot repair) hands a snapshot written AFTER the account's login died,
    // which is provably foreign in whole, and has no window to filter with.
    const keep = prev.scopedWeekly.filter((s) => s && s.name && agrees(s.resetsAt, own(s.name)));
    if (keep.length) {
      out.scopedWeekly = keep.map((s) => ({ name: s.name, utilization: s.utilization, resetsAt: s.resetsAt || 0 }));
      if (typeof prev.scopedFetchedAt === 'number') out.scopedFetchedAt = prev.scopedFetchedAt;
      out.scopedPreservedBy = 'window-repair';   // this half is older than `fetchedAt`, and says so
    }
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
/** THE JOIN THE TWO STORES DID NOT HAVE (2026-09-07 r3, reproduced).
 *
 *  The transition ledger is keyed by the WEBUI session key (`sess-<seq>-<ms>`)
 *  — that is what `ensureSessionPoolLink` is called with, what the daemon's
 *  link basename spells, and what the engine's journal line prints. The
 *  attribution log is keyed by the CLAUDE CONVERSATION id (a UUID) — that is
 *  what `recordUsageAttribution` receives. Looking one up with the other's key
 *  can never match a session-scoped row, so every plan-C conversation silently
 *  fell through to the POOL DEFAULT's answer, and that answer was written into
 *  the live store: a conversation's spend moved to a member its own credential
 *  link was never on.
 *
 *  Translating here (rather than recording both ids on the row) is deliberate:
 *  a row is written at the instant a LINK moves, and at spawn the conversation
 *  id does not exist yet; the daemon's sealed-orders reflex and the journal
 *  backfill have only the link path / the printed webui id. session-meta holds
 *  the mapping for every one of them, uniformly and after the fact.
 *
 *  ONE CONVERSATION, MANY WEBUI KEYS: a resume or fork carries the same
 *  claudeSessionId under a new `sess-…`, so this is one-to-MANY over time. We
 *  return every candidate whose key is not NEWER than the entry (the key
 *  embeds its own creation ms), and `slotAt` picks the latest matching row —
 *  i.e. the session that was actually live at that instant. A key we cannot
 *  date is always a candidate (fixtures, hand-written keys).
 *
 *  @returns Map(claudeSessionId → [{key, at}])  */
function _sessionKeyMap(dataDir) {
  const out = new Map();
  const dir = path.join(dataDir, 'session-meta');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const fn of files) {
    if (!fn.endsWith('.json')) continue;
    const m = _readJson(path.join(dir, fn));
    if (!m) continue;
    const sid = m.claudeSessionId || m.backendSessionId;
    if (!sid) continue;
    // the meta FILE is `cw-<seq>-<ms>.json`; the session key is
    // `sess-<seq>-<ms>` (ws-create derives one from the other — 2.304.0, "the
    // socket name is DERIVED FROM THE ID"), so the key is recoverable from the
    // filename alone and does not depend on any field being persisted.
    const base = fn.slice(0, -5);
    if (!/^cw-\d+-\d+$/.test(base)) continue;
    const key = 'sess-' + base.slice('cw-'.length);
    const at = Number(base.slice(base.lastIndexOf('-') + 1)) || null;
    const list = out.get(sid) || [];
    list.push({ key, at });
    out.set(sid, list);
  }
  return out;
}
/** Every webui key that could have been carrying conversation `sid` at `ts`. */
function sessionKeysFor(keyMap, sid, ts) {
  const list = (keyMap && keyMap.get(sid)) || [];
  return list.filter((e) => e.at == null || e.at <= ts).map((e) => e.key);
}

function repairAttribution({ dataDir, historyDir, archiveDir, markers, transitions, id }) {
  const res = { scanned: 0, foreign: 0, reattributed: 0, archived: 0, emptied: 0, unjoinable: 0 };
  const fp = path.join(historyDir, 'attribution.ndjson');
  let txt = ''; try { txt = fs.readFileSync(fp, 'utf-8'); } catch { return res; }
  const keyMap = _sessionKeyMap(dataDir || path.dirname(historyDir));
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
    //
    // The ledger speaks WEBUI keys and this entry names a CONVERSATION, so the
    // lookup goes through the session-meta join above. Only a SESSION-SCOPED
    // row may rewrite a stored fact (2026-09-07 r3): the pool default is the
    // right answer for a conversation that had no link of its own, and we
    // cannot prove that about a historical entry — substituting it moved a
    // conversation's spend onto a member its own link was never on. Unjoinable
    // and default-only entries are ARCHIVED, which is the honest outcome the
    // ledger's "unknown, never agreement" contract already promises.
    const keys = sessionKeysFor(keyMap, r.sid, r.ts);
    const slot = (transitions && keys.length) ? transitions.slotAt(keys, r.ts, { poolId: r.pool || null }) : null;
    const usable = slot && slot.scope === 'session' && !slot.ownLinkUnknown;
    if (usable && slot.id && slot.id !== r.acct && !isForeign(markers, slot.id, r.ts)) {
      archived.push({ migration: id, at: Date.now(), store: 'attribution', reason: `re-attributed to ${slot.id} (slot transition at ${new Date(slot.at).toISOString()}, scope ${slot.scope}, via session ${keys.join('/')})`, entry: r });
      out.push(JSON.stringify({ ...r, acct: slot.id, repairedBy: id }));
      if (r.sid) sidsKept.add(r.sid);
      res.reattributed++; dirty = true;
      continue;
    }
    if (!keys.length) res.unjoinable++;
    const why = !keys.length
      ? 'no webui session key for this conversation (session-meta is gone) ⇒ the ledger cannot be asked about it'
      : slot ? 'only the POOL DEFAULT answers for it — its own link is unknown, and the default is not evidence about a conversation that may have had one'
        : 'no slot transition on record';
    archived.push({ migration: id, at: Date.now(), store: 'attribution', reason: `attributed to ${r.acct} at ${new Date(r.ts).toISOString()}, after that login was ${m.state} at ${new Date(m.since).toISOString()}; ${why} ⇒ cannot re-attribute`, entry: r });
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
  report.attribution = repairAttribution({ dataDir, historyDir: path.join(dataDir, 'usage-history'), archiveDir, markers, transitions, id });
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

// ── ④ THE WINDOW REPAIR (inc-mts8a8mr-ulmm, 2026-09-08) ─────────────────────
// The 2026-09-07 repair could only act where a member's own credential file
// DATED its death — on this instance that was ONE member (`members:1` in the
// migration's own log), so every entry mis-filed BETWEEN TWO LOGGED-IN members
// survived it, invisible by construction: that is the "silent half" its own
// header names.
//
// The reading itself carries the evidence that repair lacked. A weekly reset is
// an account property — measured over this instance's whole corpus (6 634
// anchors, 30 days, 7 live subscriptions) each identity has exactly ONE weekly
// reset phase, stable across the period, and the seven are all distinct; a roll
// moves `resetsAt` by exactly one week, so the PHASE survives it. An entry
// whose weekly phase is not its stream's is therefore provably not that
// account's, whatever the account's login was doing at the time.
//
// STRICTLY EVIDENCE-LED, like ②: an identity establishes its window only from
// its OWN on-demand (panel) readings — the producer whose key and credential
// dir are one decision — and only with enough of them to be a fact rather than
// a coincidence. Candidates for RE-FILING are further restricted to identities
// whose account is still on the roster: a removed subscription cannot receive
// readings, and on this instance one removed account shares PandyMax's weekly
// phase, which would make every genuinely re-filable entry ambiguous.
const MIN_OWN_READINGS = 5;   // fewer than this is a coincidence, not a window
const OWN_DOMINANCE = 0.9;    // a stream whose own panel readings disagree with themselves establishes nothing
const { weeklyNear, weeklyPhase, windowOf, windowFingerprint, windowSidecarName, decideReadingTarget } = require('./reading-lag.js');
// The identity a usage-cache FILE belongs to, and the slug its anchor stream is
// named with — both taken from the producer rather than re-spelled here (r5).
const { identityKeyFor, anchorSlug } = require('./usage-anchors.js');

/** Tally one weekly `resetsAt` into a phase histogram, merging the ±60 s wobble
 *  the panel and the event stream spell the SAME window with. Keeps the newest
 *  actual value per phase so a rolled window is quoted at its current instant. */
function _tallyPhase(hist, resetsAt, at) {
  let hit = null;
  for (const p of hist.keys()) if (weeklyNear(p, resetsAt)) { hit = p; break; }
  const k = hit == null ? weeklyPhase(resetsAt) : hit;
  const cur = hist.get(k) || { n: 0, resetsAt, at: 0 };
  cur.n++;
  if ((at || 0) >= cur.at) { cur.at = at || 0; cur.resetsAt = resetsAt; }
  hist.set(k, cur);
  return cur;
}
/** The dominant phase of a histogram, or null when the evidence is too thin or
 *  too split to be a fingerprint (the same two thresholds everywhere). */
function _dominant(hist) {
  const total = [...hist.values()].reduce((a, b) => a + b.n, 0);
  if (!total) return null;
  const [phase, top] = [...hist.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  if (top.n < MIN_OWN_READINGS || top.n / total < OWN_DOMINANCE) return null;
  return { phase, resetsAt: top.resetsAt, n: top.n, total };
}

/** identityKey → {window, accountId, phase, n, total} from that stream's OWN
 *  on-demand readings. `roster` (account ids) decides who may RECEIVE a
 *  re-filed entry; every stream is still a SUBJECT of the check.
 *
 *  THE SCOPED HALF IS EVIDENCE TOO (r4, reproduced on a copy of this instance).
 *  The first spelling established only `{sevenDay, fiveHour:null, scoped:{}}` —
 *  it THREW AWAY the model-scoped weekly buckets, which are the other half of
 *  what a reading states about itself. That is not a smaller check, it is a
 *  BLIND one: 444 of this instance's anchors carry a foreign 7d ON TOP OF the
 *  stream's OWN Fable bucket (the shape a mis-keyed statusline write makes —
 *  it rewrites {5h,7d} from its payload and PRESERVES the file's existing
 *  scopedWeekly), so deciding on the 7d alone moved 443 records — Fable bucket
 *  and all — onto an account whose Fable window they contradict, and
 *  `repairCachesByWindow` then rebuilt a cache from one of them. The repair
 *  was manufacturing the 2.305.0 scoped-bucket misattribution it exists to
 *  clean up.
 *  Measured on the same corpus, a scoped weekly is exactly as much of an
 *  account fingerprint as the 7d: every identity's own on-demand Fable phase
 *  is its own 7d phase (32340/32400, 532740/532800, 320340/320400/320399,
 *  143940/144000/143999, 557999/558000, 579540/579600, 493140/493200 — every
 *  cluster inside the ±120 s tolerance), and the seven are distinct. So each
 *  scoped bucket gets the SAME evidence-led treatment as the 7d: its own
 *  histogram over the stream's own panel readings, and it establishes nothing
 *  unless it clears MIN_OWN_READINGS and OWN_DOMINANCE on its own. */
function establishedWindows(anchorFiles, { roster = null } = {}) {
  const out = new Map();
  for (const f of anchorFiles) {
    const buckets = new Map();   // representative 7d phase → {n, resetsAt, at}
    const scoped = new Map();    // lowercased bucket name → its own histogram
    const accts = new Map();
    for (const r of f.rows) {
      if (!r) continue;
      accts.set(r.accountId || '__global__', (accts.get(r.accountId || '__global__') || 0) + 1);
      if (r.source !== 'on-demand') continue;
      const ra = r.buckets?.sevenDay?.resetsAt;
      if (ra) _tallyPhase(buckets, ra, r.fetchedAt);
      for (const s of (Array.isArray(r.buckets?.scopedWeekly) ? r.buckets.scopedWeekly : [])) {
        if (!s || !s.name || !(Number(s.resetsAt) > 0)) continue;
        const nm = String(s.name).toLowerCase();   // windowOf lowercases too — one namespace
        if (!scoped.has(nm)) scoped.set(nm, new Map());
        _tallyPhase(scoped.get(nm), Number(s.resetsAt), r.fetchedAt);
      }
    }
    const top = _dominant(buckets);
    if (!top) continue;
    const accountId = [...accts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const sc = {};
    const scMeta = {};
    for (const [nm, hist] of scoped) {
      const d = _dominant(hist);
      if (!d) continue;                        // thin or split ⇒ no claim about this bucket
      sc[nm] = d.resetsAt; scMeta[nm] = { phase: d.phase, n: d.n, of: d.total };
    }
    out.set(f.name.replace(/^anchors-|\.ndjson$/g, ''), {
      file: f, phase: top.phase, n: top.n, total: top.total, accountId, scoped: scMeta,
      window: { sevenDay: top.resetsAt, fiveHour: null, scoped: sc },
      canReceive: !roster || roster.includes(accountId),
    });
  }
  return out;
}

/** ONE bucket's verdict, asked with a window carrying NOTHING BUT that bucket,
 *  so a bucket can never speak for another one in the same record.
 *  `target` = the identity this bucket proves it belongs to (the stream itself
 *  when it agrees), or null when nothing can be proven. */
function _bucketVerdict(ident, bucketWindow, allWindows) {
  const d = decideReadingTarget({ key: ident, readingWindow: bucketWindow, windows: allWindows });
  return { ...d, target: d.action === 'write' ? ident : d.action === 'refile' ? d.key : null };
}
/** WHY THIS BUCKET DID NOT TRAVEL. `decideReadingTarget`'s own `reason` answers
 *  "does this bucket belong to the stream it is sitting in" — a DIFFERENT
 *  question, so quoting it here would file a line saying "window matches the
 *  target" under a bucket that was dropped (measured on this instance: 443 of
 *  444 drop lines said exactly that). A reason string is an assertion about the
 *  system, and the assertion this line makes is about the DESTINATION. */
function _dropReason(v, dest, ident) {
  if (!v) return `states no weekly window, so it cannot be shown to be ${dest}'s`;
  if (v.target === ident) return `its weekly window is ${ident}'s, not ${dest}'s — it did not travel with the record`;
  if (v.target) return `its weekly window is ${v.target}'s, not ${dest}'s — it did not travel with the record`;
  return `its weekly window matches no account that may receive readings, so it cannot be shown to be ${dest}'s (${v.reason})`;
}
/** THE PRIMARY HALF IS DECIDED ON THE RECORD'S BUCKETS, NOT ON THE WINDOW
 *  (r5, reproduced). {5h, 7d} is one payload so they leave together, but the
 *  lines were written off `win` — the DATED view — so a record whose primary
 *  half states no `resetsAt` had it silently deleted from the moved row: no
 *  drop line, `bucketsArchived: 0`, counted as a WHOLE re-file, and the
 *  placeholder reason `'window'` in the journal and the archive. That shape is
 *  ordinary: `vibespace-usage` writes `{u: 0}` with no window for an absent
 *  bucket and `maybeRecord` keeps the utilization, and 2392 of this instance's
 *  7106 anchors carry an undated primary bucket beside a dated scoped one.
 *  An undated bucket can be neither confirmed nor refused, so it RIDES ALONG
 *  while the record stays — but moving it is a positive claim about an account
 *  it cannot be shown to belong to, which is the whole class of defect this
 *  repair is made of. So every primary bucket the record actually STATES gets
 *  its own archived line, dated or not, and the move is counted PARTIAL. */
function _primaryDrops(prim, dest, ident, buckets) {
  const b = buckets || {};
  const out = [];
  if (b.sevenDay) out.push({ bucket: 'sevenDay', reason: (Number(b.sevenDay.resetsAt) > 0 && prim) ? _dropReason(prim, dest, ident) : _dropReason(null, dest, ident) });
  if (b.fiveHour) {
    out.push({
      bucket: 'fiveHour',
      reason: `a five-hour window names a TIME, not an account, and the seven-day half it travels with ${b.sevenDay ? `is not ${dest}'s` : `is absent from this record`} — it cannot be shown to be ${dest}'s`,
    });
  }
  return out;
}

/** Re-file or archive every anchor whose window is not its stream's, then
 *  re-chain what that broke. A moved record is INSERTED IN TIME ORDER into the
 *  owning stream with `prevFetchedAt`/`costSince` voided: its Δu is real for
 *  that account but the cost interval it was measured over is not, and
 *  `extractPairs` pairs on the explicit chain, so an unchained record teaches
 *  nothing and breaks nothing (it is data, kept, never a forged pair).
 *
 *  PER BUCKET, NEVER WHOLESALE (r4, reproduced on a copy of this instance).
 *  An anchor is a snapshot of a usage-cache FILE, and that file is written by
 *  more than one producer: the statusline rewrites {5h, 7d} from its own
 *  payload and PRESERVES whatever `scopedWeekly` the file already held (it has
 *  no scoped buckets of its own — the 2.70.0 Fable-vanishing rule). So a
 *  reading that landed on the wrong key before the window guard existed leaves
 *  a record that is ITSELF A MIX: another account's 7d sitting on top of this
 *  stream's own Fable bucket. Measured here: 444 such records, against 32 whose
 *  halves are both foreign and 4466 clean ones. Handing the whole window to
 *  `decideReadingTarget` decided on the 7d alone (the scoped half could not
 *  even be compared, because `establishedWindows` was discarding it) and moved
 *  443 records — Fable bucket and all — onto an account whose Fable window they
 *  contradict; `repairCachesByWindow` then rebuilt a cache from one of them and
 *  wrote another member's model-scoped bucket, `resetsAt` and `scopedFetchedAt`
 *  over the target's own. `accountRemaining` / `weeklyDeadline` / `bucketRems`
 *  all read `cache.scopedWeekly`, so the repair was manufacturing exactly the
 *  2.305.0 scoped-bucket misattribution it exists to clean up.
 *
 *  Each bucket is therefore disposed of BY ITS OWN EVIDENCE:
 *    · the PRIMARY half is {5h, 7d} — one payload, one producer, one
 *      credential — so the 5h travels with the 7d and never alone (a 5-hour
 *      window names a TIME, not an account, and can prove nothing by itself);
 *    · every scoped weekly bucket is judged on its own phase;
 *    · the RECORD follows its primary half, and carries ONLY the buckets that
 *      agree with wherever it lands. Every other bucket is archived with its
 *      own reason — the archive line keeps the ORIGINAL WHOLE RECORD, so
 *      nothing is destroyed and the offline corpus can still re-derive it;
 *    · a record with no agreeing bucket at all is archived, not moved. */
function repairAnchorsByWindow({ anchorsDir, archiveDir, anchorFiles, windows, id, now = Date.now() }) {
  const res = { streams: 0, refiled: 0, refiledWhole: 0, refiledPartial: 0, stripped: 0, bucketsArchived: 0, archived: 0, voided: 0, ratesReset: false, byTarget: {} };
  const receivers = [...windows.entries()].filter(([, w]) => w.canReceive);
  const winMap = {}; for (const [k, w] of receivers) winMap[k] = w.window;
  const moves = new Map();  // target identityKey → [rows]
  const archived = [];
  const touched = new Set();
  for (const [ident, info] of windows) {
    const f = info.file;
    const keep = [], gone = [];
    for (const r of f.rows) {
      const win = windowOf(r.buckets || {});
      const sw = Array.isArray(r.buckets?.scopedWeekly) ? r.buckets.scopedWeekly : [];
      const names = Object.keys(win.scoped);
      if (!win.sevenDay && !names.length) { keep.push(r); continue; }  // no weekly evidence at all — nothing to judge
      const all = { ...winMap, [ident]: info.window };
      const prim = win.sevenDay ? _bucketVerdict(ident, { sevenDay: win.sevenDay, fiveHour: null, scoped: {} }, all) : null;
      const scv = new Map();
      for (const nm of names) scv.set(nm, _bucketVerdict(ident, { sevenDay: null, fiveHour: null, scoped: { [nm]: win.scoped[nm] } }, all));
      // WHERE THE RECORD GOES: its primary half decides, because that is the
      // half a producer wrote as one payload. With no primary (or an
      // unprovable one) the record stays wherever a bucket proves it belongs,
      // and only unanimous scoped evidence may move it.
      let dest;
      if (prim) dest = prim.target;
      else {
        const tg = [...new Set([...scv.values()].map((v) => v.target))];
        dest = tg.length === 1 ? tg[0] : (tg.includes(ident) ? ident : null);
      }
      if (dest == null && [...scv.values()].some((v) => v.target === ident)) dest = ident;
      if (dest == null) {                                    // nothing in it can be proven to belong anywhere
        gone.push(r);
        archived.push({ migration: id, at: now, store: 'usage-anchors', file: f.name, action: 'archived', reason: (prim || [...scv.values()][0]).reason, entry: r });
        res.archived++;
        continue;
      }
      const primKept = prim ? prim.target === dest : dest === ident;
      const drops = [];
      const keptScoped = [];
      for (const s of sw) {
        const nm = s && s.name ? String(s.name).toLowerCase() : null;
        const v = nm ? scv.get(nm) : null;
        if (!v) {
          // A bucket that states no window can be neither confirmed nor
          // refused ("no evidence ⇒ no refusal"), so it stays while the record
          // stays — but MOVING it is a positive claim about an account it
          // cannot be shown to belong to, and this whole class of defect is
          // made of exactly those claims. 705 scoped entries on this instance
          // carry no `resetsAt`, and `bucketRemaining` still reads their
          // utilization, so they are money.
          if (dest === ident) keptScoped.push(s);
          else drops.push({ bucket: nm || '(unnamed)', reason: _dropReason(null, dest, ident) });
          continue;
        }
        if (v.target === dest) keptScoped.push(s);
        else drops.push({ bucket: nm, reason: _dropReason(v, dest, ident) });
      }
      if (!primKept) drops.push(..._primaryDrops(prim, dest, ident, r.buckets));
      if (dest === ident) {
        if (drops.length) {                                  // stays, stripped of what provably is not its
          const orig = { ...r, buckets: r.buckets };         // the archive keeps the record as it was
          r.buckets = {
            fiveHour: primKept ? (r.buckets?.fiveHour ?? null) : null,
            sevenDay: primKept ? (r.buckets?.sevenDay ?? null) : null,
            scopedWeekly: keptScoped,
          };
          r.repairedBy = id;
          r.strippedBuckets = drops.map((x) => x.bucket);
          archived.push({ migration: id, at: now, store: 'usage-anchors', file: f.name, action: 'buckets-archived', to: ident, buckets: drops, entry: orig });
          res.stripped++; res.bucketsArchived += drops.length;
          touched.add(ident);
        }
        keep.push(r);
        continue;
      }
      gone.push(r);
      const tgt = windows.get(dest);
      const row = {
        ...r, accountId: tgt.accountId === '__global__' ? null : tgt.accountId, identityKey: dest,
        buckets: {
          fiveHour: primKept ? (r.buckets?.fiveHour ?? null) : null,
          sevenDay: primKept ? (r.buckets?.sevenDay ?? null) : null,
          scopedWeekly: keptScoped,
        },
        prevFetchedAt: null, elapsedSec: null, costSince: null, calib: undefined, accountIds: undefined,
        // WHY THE RECORD MOVED — never a drop line (that sentence is about a
        // bucket that did NOT move) and never the `'window'` placeholder: with
        // no primary half the record followed a SCOPED bucket, so that bucket's
        // verdict is the reason, and a reason string is an assertion.
        repairedBy: id, refiledFrom: ident, refiledReason: (primKept && prim ? prim.reason : (([...scv.values()].find((v) => v.target === dest) || {}).reason || (drops[0] && drops[0].reason) || 'window')),
        ...(drops.length ? { droppedBuckets: drops.map((x) => x.bucket) } : {}),
      };
      delete row.calib; delete row.accountIds;
      (moves.get(dest) || moves.set(dest, []).get(dest)).push(row);
      archived.push({
        migration: id, at: now, store: 'usage-anchors', file: f.name, action: 'refiled', to: dest,
        reason: row.refiledReason, ...(drops.length ? { buckets: drops } : {}), entry: r,
      });
      res.refiled++;
      if (drops.length) { res.refiledPartial++; res.bucketsArchived += drops.length; } else res.refiledWhole++;
      res.byTarget[dest] = (res.byTarget[dest] || 0) + 1;
    }
    // a stream that only had BUCKETS stripped still changed, and the report
    // must say so — "streams: 0" about a run that rewrote a stream is the same
    // kind of quiet lie the per-bucket counters exist to prevent
    if (!gone.length) { if (touched.has(ident)) res.streams++; continue; }
    res.streams++;
    keep.sort((a, b) => (a.fetchedAt || 0) - (b.fetchedAt || 0));
    const dropped = new Set(gone.map((r) => r.fetchedAt));
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
    f.rows = keep;
    touched.add(ident);
  }
  for (const [ident, rows] of moves) {
    const tgt = windows.get(ident);
    if (!tgt) continue;
    tgt.file.rows = [...tgt.file.rows, ...rows].sort((a, b) => (a.fetchedAt || 0) - (b.fetchedAt || 0));
    touched.add(ident);
  }
  if (!touched.size) return res;
  _appendArchive(archiveDir, 'readings-window-anchors.ndjson', archived);
  for (const ident of touched) {
    const f = windows.get(ident).file;
    _writeAtomic(f.file, f.rows.map((r) => JSON.stringify(r)).join('\n') + (f.rows.length ? '\n' : ''));
  }
  const rates = path.join(anchorsDir, 'rates.json');
  const cur = _readJson(rates);
  if (cur) {
    _appendArchive(archiveDir, 'readings-window-rates.ndjson', [{ migration: id, at: now, store: 'usage-anchors/rates.json', reason: 'learned from pairs that included readings of another account — re-learned from the cleaned set', entry: cur }]);
    try { fs.unlinkSync(rates); } catch { }
    res.ratesReset = true;
  }
  return res;
}

/** Does every weekly bucket this record states, that the account has a phase
 *  for, agree with that account? (r4 — `true` only when NOTHING contradicts;
 *  a bucket the account has no established phase for is not evidence either
 *  way and does not veto.) */
function _recordAgreesWholly(r, window) {
  const b = r.buckets || {};
  if (!(Number(b.sevenDay?.resetsAt) > 0) || weeklyNear(b.sevenDay.resetsAt, window.sevenDay) !== true) return false;
  for (const s of (Array.isArray(b.scopedWeekly) ? b.scopedWeekly : [])) {
    if (!s || !s.name || !(Number(s.resetsAt) > 0)) continue;
    const own = window.scoped ? window.scoped[String(s.name).toLowerCase()] : null;
    if (own == null) continue;
    if (weeklyNear(s.resetsAt, own) === false) return false;
  }
  return true;
}

/** EVERY usage-cache FILE THE PRODUCT ACCEPTS, resolved to the identity whose
 *  readings it holds (r5, reproduced on a copy of this instance's stores).
 *
 *  r4 keyed the cache half on ONE account per stream — `w.accountId`, the most
 *  frequent `accountId` among the stream's rows — and that is not the same
 *  question as "which cache files are this identity's". An org-merged login
 *  surfaces as BOTH `__global__.json` (the machine login) and the named
 *  subscription, and `usageIdentityGroups` puts them in ONE group precisely
 *  because they are one quota; on this instance `usage-cache/__global__.json`
 *  carries the same `orgUuid` as its named sibling and that identity's stream
 *  holds 47 rows keyed to it. Being invisible here had three consequences, all
 *  silent: it was never repaired, so a foreign window in it survived the
 *  migration; it was never SEEDED, so `guardReadingTarget` — whose `windows`
 *  map is keyed by CACHE FILE NAME — had no entry for `__global__` and was
 *  structurally inert on it, writing whatever bookkeeping asked; and because
 *  `sweepUsageAnchors` anchors the FRESHEST cache of a group, one sweep of a
 *  foreign `__global__.json` re-poisons the stream the migration just cleaned.
 *
 *  So the files are ENUMERATED with the product's own predicate and each is
 *  resolved with the product's own rule:
 *    · FORWARD (`identityKeyFor` over the file itself, plus the roster's
 *      backend/type/email exactly as `usageIdentityGroups` reads them) — this
 *      is the live answer and it WINS whenever it names an identity;
 *    · the `acct:` fallback is `identityKeyFor`'s own documented LAST RESORT,
 *      i.e. the file states no org and no email. The engine can still key such
 *      an account by email because `accounts.list()` reads it out of the
 *      CREDENTIAL DIR, which this migration (running before any AccountManager
 *      exists) cannot; two live members here are in exactly that state. Their
 *      own stream names them in `accountId`, written beside `identityKey` from
 *      the SAME group at the SAME moment, so it is the historical forward
 *      answer rather than a guess — and it can only be used when exactly ONE
 *      established stream names the account. A reassignment cannot sneak
 *      through it: a login that moved orgs writes the new `orgUuid` into the
 *      file, and the forward rung reads that first.
 *  Pseudo keys are deliberately excluded from the fallback index: the engine
 *  records `accountId: null` for BOTH `__global__.json` and
 *  `__global_codex__.json`, so a null row cannot tell the two apart (measured:
 *  the codex stream's 1532 rows are null-keyed exactly like a claude machine
 *  login's would be). Both are named by the forward rung anyway.
 *  `host-*` is excluded for the same reason the engine excludes it from
 *  identity groups: `usage-cache/host-<id>.json` is that HOST's own claude
 *  login, no anchor stream describes it, and this migration therefore has no
 *  established window to judge or seed it with. */
function identityCacheKeys(cacheDir, windows, { accounts = null } = {}) {
  const out = [];
  // accountId -> the established, receivable identities whose stream names it
  const byRowAcct = new Map();
  for (const [ident, w] of windows) {
    if (!w.canReceive) continue;
    const seen = new Set();
    for (const r of w.file.rows) {
      const a = r && r.accountId;
      if (!a || a === '__global__' || a === '__global_codex__' || seen.has(a)) continue;
      seen.add(a);
      (byRowAcct.get(a) || byRowAcct.set(a, []).get(a)).push(ident);
    }
  }
  let names = [];
  // the predicate is `usageIdentityGroups`', verbatim
  try { names = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json') && !f.startsWith('__models__') && !f.startsWith('host-') && f !== 'rates.json'); } catch { return out; }
  for (const fn of names.sort()) {
    const key = fn.slice(0, -5);
    const cache = _readJson(path.join(cacheDir, fn));
    if (!cache) { out.push({ key, file: fn, cache: null, ident: null, why: 'unreadable' }); continue; }
    const accountId = (key === '__global__' || key === '__global_codex__') ? null : key;
    const rec = accountId && accounts ? accounts.find((a) => a && a.id === accountId) : null;
    // a cache file with no roster record is a zombie the product already
    // ignores, and a pool holds no quota of its own — both skipped there, both
    // skipped here, for the same reasons
    if (accountId && accounts && !rec) { out.push({ key, file: fn, cache, ident: null, why: 'no roster record — the product ignores this file too' }); continue; }
    if (rec && rec.type === 'pooled') { out.push({ key, file: fn, cache, ident: null, why: 'a pool holds no quota of its own' }); continue; }
    const fwd = key === '__global_codex__' ? 'codex:__global__'
      : ((rec && rec.backend === 'codex') ? 'codex:' : '') + identityKeyFor({ accountId, cache, email: rec ? rec.email : undefined });
    const slug = anchorSlug(fwd);
    if (windows.has(slug) && windows.get(slug).canReceive) { out.push({ key, file: fn, cache, ident: slug, via: 'identity' }); continue; }
    // the file NAMED an identity, so the streams are not asked — each refusal
    // says which of the two things is missing, because a line that says "no
    // established window" about an identity that has one is a false diagnosis
    if (!/^acct:/.test(fwd)) {
      out.push({ key, file: fn, cache, ident: null, why: windows.has(slug) ? `its identity ${fwd} may not receive readings (its account is not on the roster)` : `its identity ${fwd} has no established window` });
      continue;
    }
    const hits = byRowAcct.get(key) || [];
    if (hits.length === 1) { out.push({ key, file: fn, cache, ident: hits[0], via: 'stream' }); continue; }
    out.push({ key, file: fn, cache, ident: null, why: hits.length ? `the file states no identity and ${hits.length} established streams name this account` : 'the file states no identity and no established stream names this account' });
  }
  return out;
}

/** Seed the account's own window into every roster account's sidecar, and
 *  rescue a cache whose CURRENT snapshot carries another account's window.
 *  The seed is what ARMS the live guard on the upgrade: the window is stamped
 *  only by the panel refresh, so without it the guard would stay inert on every
 *  account until its next `claude -p /usage` — up to the refresher's whole
 *  wandering 30-60 min idle interval, on exactly the machine we have just
 *  proven has the bug. Since r4 the seeded sidecar carries the SCOPED phases
 *  too, so the live guard is armed on the model-scoped buckets as well — the
 *  live panel producer has always stamped them (usage-routes writes
 *  `windowOf(merged)`), the migration was the half that dropped them.
 *
 *  THE REBUILD MAY NOT IMPORT A FOREIGN BUCKET (r4, reproduced). `best` used to
 *  be "the newest record whose 7d is ours", which after the wholesale re-file
 *  was frequently a record carrying ANOTHER member's Fable bucket — and
 *  `_cacheFromAnchor` copied it, `resetsAt` and `scopedFetchedAt` and all, over
 *  this account's own. Measured on a copy of this instance's stores AFTER the
 *  r3 migration, the `best` for one of the seven members was exactly such a row
 *  (`refiledFrom` naming the other member). So `best` is now chosen only among
 *  records ALL of whose judgeable weekly buckets agree, and `_cacheFromAnchor`
 *  filters on the window as a second, independent barrier. */
function repairCachesByWindow({ cacheDir, archiveDir, windows, accounts = null, id, now = Date.now() }) {
  const res = { keys: 0, seeded: 0, foreign: 0, restored: 0, scopedStripped: 0, unresolved: [] };
  for (const k of identityCacheKeys(cacheDir, windows, { accounts })) {
    if (!k.ident) { res.unresolved.push({ key: k.key, why: k.why }); continue; }
    const acct = k.key, w = windows.get(k.ident);
    const fp = path.join(cacheDir, k.file);
    const cur = k.cache;
    if (!cur) continue;
    res.keys++;
    const snap = windowOf(cur);
    let next = cur;
    if (snap.sevenDay && weeklyNear(snap.sevenDay, w.window.sevenDay) === false) {
      res.foreign++;
      _appendArchive(archiveDir, 'readings-window-usage-cache.ndjson', [{
        migration: id, at: now, store: 'usage-cache', key: acct,
        reason: `snapshot window ${windowFingerprint(snap)} is not this account's (${windowFingerprint(w.window)})`,
        entry: cur,
      }]);
      // the newest reading of this account that is ENTIRELY its own window
      let best = null;
      for (const r of w.file.rows) {
        if (!_recordAgreesWholly(r, w.window)) continue;
        if (!best || (r.fetchedAt || 0) > (best.fetchedAt || 0)) best = r;
      }
      if (best) { next = _cacheFromAnchor(best, cur, w.window); res.restored++; }
      else {
        next = {};
        for (const f of IDENTITY_FIELDS) if (cur[f] !== undefined) next[f] = cur[f];
        next.repairedBy = id;
      }
    } else {
      // THE 7d AGREES BUT A SCOPED BUCKET DOES NOT (r4). The rebuild branch
      // above never fires for this shape, so before r4 nothing on any path
      // could clean it — and the pool reads `cache.scopedWeekly` directly. The
      // fresh, correct 7d is kept and only the provably foreign bucket is
      // stripped: a whole rebuild from an older anchor would throw away good
      // numbers to fix a bad one.
      const bad = (Array.isArray(cur.scopedWeekly) ? cur.scopedWeekly : []).filter((s) => {
        const own = s && s.name ? w.window.scoped[String(s.name).toLowerCase()] : null;
        return own != null && Number(s.resetsAt) > 0 && weeklyNear(s.resetsAt, own) === false;
      });
      if (bad.length) {
        _appendArchive(archiveDir, 'readings-window-usage-cache.ndjson', [{
          migration: id, at: now, store: 'usage-cache', key: acct, action: 'scoped-stripped',
          reason: `model-scoped bucket(s) ${bad.map((s) => `${s.name}@${weeklyPhase(s.resetsAt)}`).join(', ')} are not this account's (${windowFingerprint(w.window)}) — the pool reads scopedWeekly for accountRemaining/weeklyDeadline/bucketRems`,
          entry: cur,
        }]);
        const keptSw = cur.scopedWeekly.filter((s) => !bad.includes(s));
        next = { ...cur, scopedWeekly: keptSw };
        if (!keptSw.length) delete next.scopedFetchedAt;
        next.repairedBy = id;
        res.scopedStripped += bad.length;
      }
    }
    // SEED THE SIDECAR, not the snapshot (r2): the snapshot is rebuilt whole by
    // every reading producer, so a window written here would be deleted by the
    // next statusline render — which is the defect this migration exists to
    // repair the data for. Any legacy in-snapshot copy is stripped in passing.
    delete next.ownWindow;
    _writeAtomic(path.join(cacheDir, windowSidecarName(acct)), JSON.stringify({ ...w.window, at: now, source: 'on-demand', seededBy: id }));
    res.seeded++;
    _writeAtomic(fp, JSON.stringify(next));
  }
  return res;
}

/** THE window repair. Same contract as repairReadings: archive-never-destroy,
 *  every archived row carries a reason, idempotent, atomic. */
function repairByWindow({ dataDir, roster = null, accounts = null, id = 'readings-by-window', now = Date.now() }) {
  const archiveDir = path.join(dataDir, 'archive');
  const anchorsDir = path.join(dataDir, 'usage-anchors');
  const anchorFiles = _readAnchorFiles(anchorsDir);
  const windows = establishedWindows(anchorFiles, { roster });
  const report = {
    id, at: now,
    // `scoped` names each model-scoped weekly phase this identity established
    // from its OWN panel readings — the half r3 discarded, and the reason its
    // re-files could contradict the target they were filed onto.
    identities: [...windows.entries()].map(([k, w]) => ({ key: k, accountId: w.accountId, phase: w.phase, own: w.n, of: w.total, canReceive: w.canReceive, scoped: w.scoped })),
    anchors: repairAnchorsByWindow({ anchorsDir, archiveDir, anchorFiles, windows, id, now }),
    caches: null,
  };
  report.caches = repairCachesByWindow({ cacheDir: path.join(dataDir, 'usage-cache'), archiveDir, windows, accounts, id, now });
  return report;
}

module.exports = { repairReadings, deathMarkers, isForeign, backfillFromJournal, findJournal, repairUsageCaches, repairAnchors, repairAttribution, sessionKeysFor, _sessionKeyMap, repairByWindow, establishedWindows, identityCacheKeys, repairAnchorsByWindow, repairCachesByWindow, _cacheFromAnchor, _recordAgreesWholly, _primaryDrops, MIN_OWN_READINGS, OWN_DOMINANCE };
