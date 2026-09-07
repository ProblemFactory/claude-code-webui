'use strict';
// THE SLOT-TRANSITION LEDGER (2026-09-07, readings-by-slot part 2).
//
// A pooled conversation's billing identity is a SYMLINK, and a symlink has no
// history: `poolCurrentFor()` can only ever answer "where does it point NOW".
// Every attribution question that arrives LATE — a reading whose fetchedAt is
// two minutes old, a ledger event baked by a scan that ran after the switch,
// a migration asked to clean up last week — therefore had no way to answer
// "which member was this conversation on AT THAT MOMENT", and the code filled
// the gap with the only durable identity it had: the org the CLI cached at
// SPAWN (OTel `organization.id`). That is the misattribution this ledger
// removes at the root: every re-point of a credential link appends a line, so
// the past is a lookup instead of an inference.
//
// Shape (append-only NDJSON, data/slot-transitions.jsonl):
//   {"sessionId":"sess-…","poolId":"pool-…","from":"sub-a","to":"sub-b",
//    "at":1788…, "why":"per-session-switch"}
//   sessionId null = the POOL DEFAULT link moved (it decides for every session
//   that has no link of its own).
//
// BOUNDED, archive-never-destroy: past MAX lines the oldest half is MOVED to
// data/archive/slot-transitions-<YYYYMMDD>.jsonl (appended, never deleted — the
// migration and any future re-attribution read it), live file keeps the tail.
const fs = require('fs');
const path = require('path');

const MAX_LINES = 20000;      // ≈2.4MB at ~120B/line; a busy pool writes a few hundred a day
const DEDUP_MS = 60000;       // an identical consecutive (session → to) inside a minute is one fact

class SlotTransitions {
  constructor({ dataDir, max = MAX_LINES } = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'slot-transitions.jsonl');
    this.archiveDir = path.join(dataDir, 'archive');
    this.max = max;
    this._last = new Map();     // key → {to, at} (dedup, memory only)
    this._cache = null;         // {mtimeMs, size, rows}
  }

  _key(sessionId) { return sessionId || '__default__'; }

  /** Append one transition. Returns the written row, or null when it was a
   *  duplicate of the previous one for the same link inside DEDUP_MS.
   *  A SAME-TARGET re-point IS recorded (it is evidence that the link was
   *  confirmed on `to` at that instant — the 740 "re-point, same target"
   *  lines in the fire-loop journal were the only trace anyone had). */
  record({ sessionId = null, poolId = null, from = null, to = null, at = Date.now(), why = null } = {}) {
    if (!to) return null;
    const k = this._key(sessionId);
    const prev = this._last.get(k);
    if (prev && prev.to === to && at - prev.at < DEDUP_MS) return null;
    const row = { sessionId: sessionId || null, poolId: poolId || null, from: from || null, to, at, ...(why ? { why: String(why).slice(0, 40) } : {}) };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
      this._last.set(k, { to, at });
      this._cache = null;
      this._maybeTrim();
      return row;
    } catch { return null; }
  }

  /** Every recorded transition, oldest first — the LIVE file plus every
   *  archived shard (the migration must not go blind at a rotation). */
  all() {
    const st = (() => { try { return fs.statSync(this.file); } catch { return null; } })();
    if (this._cache && st && this._cache.mtimeMs === st.mtimeMs && this._cache.size === st.size) return this._cache.rows;
    const rows = [];
    const eat = (fp) => {
      let txt; try { txt = fs.readFileSync(fp, 'utf-8'); } catch { return; }
      for (const line of txt.split('\n')) {
        if (!line) continue;
        try { const r = JSON.parse(line); if (r && r.to && Number.isFinite(r.at)) rows.push(r); } catch { }
      }
    };
    try {
      for (const f of fs.readdirSync(this.archiveDir)) {
        if (/^slot-transitions-\d+\.jsonl$/.test(f)) eat(path.join(this.archiveDir, f));
      }
    } catch { }
    eat(this.file);
    rows.sort((a, b) => a.at - b.at);
    if (st) this._cache = { mtimeMs: st.mtimeMs, size: st.size, rows };
    return rows;
  }

  /** The member a conversation's link pointed at at time `at`: its own latest
   *  transition at or before that instant, else the POOL DEFAULT's latest one
   *  (a session with no link of its own bills through the default), else null
   *  — "we have no record", which callers must treat as unknown, NEVER as
   *  agreement. */
  slotAt(sessionId, at, { poolId = null } = {}) {
    let own = null, dflt = null;
    for (const r of this.all()) {
      if (r.at > at) break;
      if (poolId && r.poolId && r.poolId !== poolId) continue;
      if (r.sessionId && sessionId && r.sessionId === sessionId) own = r;
      else if (!r.sessionId) dflt = r;
    }
    const hit = own || dflt;
    return hit ? { id: hit.to, at: hit.at, scope: own ? 'session' : 'default', why: hit.why || null } : null;
  }

  /** Every transition of one conversation (oldest first) — the migration walks
   *  these to place a reading between two re-points. */
  transitionsFor(sessionId) { return this.all().filter((r) => r.sessionId === sessionId); }

  _maybeTrim() {
    let txt; try { txt = fs.readFileSync(this.file, 'utf-8'); } catch { return; }
    const lines = txt.split('\n').filter(Boolean);
    if (lines.length <= this.max) return;
    const cut = Math.floor(lines.length / 2);
    try {
      fs.mkdirSync(this.archiveDir, { recursive: true });
      // APPEND, and one shard per UTC day: two trims inside the same
      // millisecond used to share a Date.now() filename and the second
      // OVERWROTE the first — an archive that silently loses what it was
      // created to preserve is worse than no archive.
      const out = path.join(this.archiveDir, `slot-transitions-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`);
      fs.appendFileSync(out, lines.slice(0, cut).join('\n') + '\n');
      fs.writeFileSync(this.file + '.tmp', lines.slice(cut).join('\n') + '\n');
      fs.renameSync(this.file + '.tmp', this.file);
      this._cache = null;
    } catch { }
  }
}

module.exports = { SlotTransitions, MAX_LINES, DEDUP_MS };
