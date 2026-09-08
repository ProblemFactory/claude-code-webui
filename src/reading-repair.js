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
// `ownWindow` rides with the identity fields on purpose: the window an
// account's buckets are counted in is a fact about WHO the account is, not a
// reading, and dropping it while rebuilding a cache would silently disarm the
// window guard for that member until its next panel refresh.
const IDENTITY_FIELDS = ['orgUuid', 'orgName', 'orgEmail', 'email', 'name', 'ownWindow'];
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
const { weeklyNear, weeklyPhase, windowOf, windowFingerprint, decideReadingTarget } = require('./reading-lag.js');

/** identityKey → {window, accountId, phase, n, total} from that stream's OWN
 *  on-demand readings. `roster` (account ids) decides who may RECEIVE a
 *  re-filed entry; every stream is still a SUBJECT of the check. */
function establishedWindows(anchorFiles, { roster = null } = {}) {
  const out = new Map();
  for (const f of anchorFiles) {
    const buckets = new Map();  // representative phase → {n, resetsAt, at}
    const accts = new Map();
    for (const r of f.rows) {
      if (!r) continue;
      accts.set(r.accountId || '__global__', (accts.get(r.accountId || '__global__') || 0) + 1);
      if (r.source !== 'on-demand') continue;
      const ra = r.buckets?.sevenDay?.resetsAt;
      if (!ra) continue;
      let hit = null;
      for (const p of buckets.keys()) if (weeklyNear(p, ra)) { hit = p; break; }
      const k = hit == null ? weeklyPhase(ra) : hit;
      const cur = buckets.get(k) || { n: 0, resetsAt: ra, at: 0 };
      cur.n++;
      if ((r.fetchedAt || 0) >= cur.at) { cur.at = r.fetchedAt || 0; cur.resetsAt = ra; }
      buckets.set(k, cur);
    }
    const total = [...buckets.values()].reduce((a, b) => a + b.n, 0);
    if (!total) continue;
    const [phase, top] = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    if (top.n < MIN_OWN_READINGS || top.n / total < OWN_DOMINANCE) continue;
    const accountId = [...accts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    out.set(f.name.replace(/^anchors-|\.ndjson$/g, ''), {
      file: f, phase, n: top.n, total, accountId,
      window: { sevenDay: top.resetsAt, fiveHour: null, scoped: {} },
      canReceive: !roster || roster.includes(accountId),
    });
  }
  return out;
}

/** Re-file or archive every anchor whose window is not its stream's, then
 *  re-chain what that broke. A moved record is INSERTED IN TIME ORDER into the
 *  owning stream with `prevFetchedAt`/`costSince` voided: its Δu is real for
 *  that account but the cost interval it was measured over is not, and
 *  `extractPairs` pairs on the explicit chain, so an unchained record teaches
 *  nothing and breaks nothing (it is data, kept, never a forged pair). */
function repairAnchorsByWindow({ anchorsDir, archiveDir, anchorFiles, windows, id, now = Date.now() }) {
  const res = { streams: 0, refiled: 0, archived: 0, voided: 0, ratesReset: false, byTarget: {} };
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
      if (!win.sevenDay) { keep.push(r); continue; }
      const d = decideReadingTarget({ key: ident, readingWindow: win, windows: { ...winMap, [ident]: info.window } });
      if (d.action === 'write') { keep.push(r); continue; }
      gone.push(r);
      if (d.action === 'refile') {
        const tgt = windows.get(d.key);
        const row = {
          ...r, accountId: tgt.accountId === '__global__' ? null : tgt.accountId, identityKey: d.key,
          prevFetchedAt: null, elapsedSec: null, costSince: null, calib: undefined, accountIds: undefined,
          repairedBy: id, refiledFrom: ident, refiledReason: d.reason,
        };
        delete row.calib; delete row.accountIds;
        (moves.get(d.key) || moves.set(d.key, []).get(d.key)).push(row);
        archived.push({ migration: id, at: now, store: 'usage-anchors', file: f.name, action: 'refiled', to: d.key, reason: d.reason, entry: r });
        res.refiled++;
        res.byTarget[d.key] = (res.byTarget[d.key] || 0) + 1;
      } else {
        archived.push({ migration: id, at: now, store: 'usage-anchors', file: f.name, action: 'archived', reason: d.reason, entry: r });
        res.archived++;
      }
    }
    if (!gone.length) continue;
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

/** Seed `ownWindow` into every roster account's cache, and rescue a cache whose
 *  CURRENT snapshot is another account's window.
 *  The seed is what ARMS the live guard on the upgrade: `ownWindow` is stamped
 *  only by the panel refresh, so without it the guard would stay inert on every
 *  account until its next `claude -p /usage` — up to the refresher's whole
 *  wandering 30-60 min idle interval, on exactly the machine we have just
 *  proven has the bug. */
function repairCachesByWindow({ cacheDir, archiveDir, windows, id, now = Date.now() }) {
  const res = { seeded: 0, foreign: 0, restored: 0 };
  const byAcct = new Map();
  for (const [ident, w] of windows) if (w.canReceive && w.accountId) byAcct.set(w.accountId, { ident, ...w });
  for (const [acct, w] of byAcct) {
    const fp = path.join(cacheDir, String(acct).replace(/[^\w.-]/g, '_') + '.json');
    const cur = _readJson(fp);
    if (!cur) continue;
    const snap = windowOf(cur);
    let next = cur;
    if (snap.sevenDay && weeklyNear(snap.sevenDay, w.window.sevenDay) === false) {
      res.foreign++;
      _appendArchive(archiveDir, 'readings-window-usage-cache.ndjson', [{
        migration: id, at: now, store: 'usage-cache', key: acct,
        reason: `snapshot window ${windowFingerprint(snap)} is not this account's (${windowFingerprint(w.window)})`,
        entry: cur,
      }]);
      // the newest reading of this account that is ITS OWN window
      let best = null;
      for (const r of w.file.rows) {
        const rw = windowOf(r.buckets || {});
        if (!rw.sevenDay || weeklyNear(rw.sevenDay, w.window.sevenDay) !== true) continue;
        if (!best || (r.fetchedAt || 0) > (best.fetchedAt || 0)) best = r;
      }
      if (best) { next = _cacheFromAnchor(best, cur); res.restored++; }
      else {
        next = {};
        for (const k of IDENTITY_FIELDS) if (cur[k] !== undefined) next[k] = cur[k];
        next.repairedBy = id;
      }
    }
    next.ownWindow = { ...w.window, at: now, source: 'on-demand', seededBy: id };
    res.seeded++;
    _writeAtomic(fp, JSON.stringify(next));
  }
  return res;
}

/** THE window repair. Same contract as repairReadings: archive-never-destroy,
 *  every archived row carries a reason, idempotent, atomic. */
function repairByWindow({ dataDir, roster = null, id = 'readings-by-window', now = Date.now() }) {
  const archiveDir = path.join(dataDir, 'archive');
  const anchorsDir = path.join(dataDir, 'usage-anchors');
  const anchorFiles = _readAnchorFiles(anchorsDir);
  const windows = establishedWindows(anchorFiles, { roster });
  const report = {
    id, at: now,
    identities: [...windows.entries()].map(([k, w]) => ({ key: k, accountId: w.accountId, phase: w.phase, own: w.n, of: w.total, canReceive: w.canReceive })),
    anchors: repairAnchorsByWindow({ anchorsDir, archiveDir, anchorFiles, windows, id, now }),
    caches: null,
  };
  report.caches = repairCachesByWindow({ cacheDir: path.join(dataDir, 'usage-cache'), archiveDir, windows, id, now });
  return report;
}

module.exports = { repairReadings, deathMarkers, isForeign, backfillFromJournal, findJournal, repairUsageCaches, repairAnchors, repairAttribution, sessionKeysFor, _sessionKeyMap, repairByWindow, establishedWindows, repairAnchorsByWindow, repairCachesByWindow, MIN_OWN_READINGS, OWN_DOMINANCE };
