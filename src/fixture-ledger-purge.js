'use strict';
/**
 * fixture-ledger-purge.js — THE ONE-SHOT PURGE of test-fixture rows from the
 * permanent usage ledger (2026-09-09, run by migration
 * `2026-09-purge-test-fixture-ledger`).
 *
 * WHAT IT REPAIRS. Until this release two suites wrote their synthetic
 * transcripts into the developer's REAL `~/.claude/projects`, and the
 * production instance's usage walk ingested them. On the author's instance:
 *   · 79,533 rows for the two synthetic session ids, claiming 982,140 tokens
 *     of `claude-fable-5` that no API request ever produced — hand-written
 *     `usage` blocks, `acct: null`, so attributed to the machine login
 *     `__global__`
 *   · 245 more rows from REAL CI-probe turns run in a throwaway cwd
 *   · 222 cursor entries pointing at directories that no longer exist
 * (measured on a COPY of those stores, 2026-09-09 14:39 UTC: 573,802 rows in →
 *  79,778 removed → 494,024 out, 79,780 archive lines, 222 cursors, 0
 *  attribution, 1,575 anchors voided across 7 files, rates dropped, 0 fixture
 *  rows left anywhere, idempotent on a second run, 1.26 s)
 * The fabricated tokens are the damage the owner saw. The real-turn rows are
 * archived too, deliberately and separately: from this release the walk refuses
 * the whole convention (src/fixture-guard.js), so leaving them would make the
 * ledger describe a class the product no longer counts. Their reason line says
 * which class each row was, and the report counts them apart — 0.04 % of the
 * ledger's rows against 13.9 % that were fabricated.
 *
 * RULES (the migration-runner contract): archive, never destroy; idempotent; a
 * failure is loud and retried next boot. Every removed row is written to
 * data/archive/ with a reason BEFORE its shard is rewritten, and each shard is
 * rewritten atomically (tmp + rename).
 *
 * THE DERIVED DAMAGE. Removing rows changes what a stored anchor's `costSince`
 * measured: that field is the ledger cost between two readings, and a fixture
 * row inside the interval inflated it. So every anchor whose interval CONTAINED
 * a removed row has its `costSince` VOIDED — the same move
 * src/reading-repair.js makes when it drops an anchor (`extractPairs` skips a
 * record with no costSince, so nothing learns from an interval we can no longer
 * cost) — and `rates.json` is archived and dropped so the estimator re-learns
 * from the cleaned pairs. Voiding is the honest move: the READING is real, the
 * cost measured beside it is not.
 */
const fs = require('fs');
const path = require('path');
const { isFixtureSid, isFixtureCwd, isFixtureProjectDir } = require('./fixture-guard.js');

function _writeAtomic(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp + '.tmp', text);
  fs.renameSync(fp + '.tmp', fp);
}
function _readJson(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; } }
/** Append-only, DATED shard: two rotations in the same millisecond must not
 *  overwrite each other (the slot-transitions r2 lesson). */
function _appendArchive(archiveDir, name, rows) {
  if (!rows.length) return;
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.appendFileSync(path.join(archiveDir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const _day = (now) => new Date(now).toISOString().slice(0, 10);

/** Why is this ledger row a fixture row? null = it is not one.
 *  The SID family is the primary evidence and the only one that survives a
 *  synthetic record: a hand-written `assistant` record has no `cwd` field, so
 *  all 79,533 poisoned rows on the author's instance carry `cwd: null`. */
function fixtureRowReason(row) {
  if (!row || typeof row !== 'object') return null;
  if (isFixtureSid(row.sid)) return 'synthetic';
  if (row.cwd && isFixtureCwd(row.cwd)) return 'fixture-cwd';
  return null;
}

/**
 * @param {object} o
 * @param {string} o.dataDir           the instance's data/ directory
 * @param {string} o.id                the migration id (stamped on every archive line)
 * @param {number} [o.now]
 * @param {boolean} [o.dryRun]         report only; touch nothing
 */
function purgeFixtureLedger({ dataDir, id, now = Date.now(), dryRun = false }) {
  const historyDir = path.join(dataDir, 'usage-history');
  const anchorsDir = path.join(dataDir, 'usage-anchors');
  const archiveDir = path.join(dataDir, 'archive');
  const report = {
    shards: 0, rowsIn: 0, rowsRemoved: 0, synthetic: 0, fixtureCwd: 0,
    // Tokens are counted PER CLASS, because the two classes are different
    // claims: `syntheticTokens` were never spent (a hand-written `usage` block)
    // while `fixtureCwdTokens` were — real CI-probe turns, dominated by cache
    // reads. One combined number would let the fabricated half hide inside the
    // real half, and this repair's whole subject is telling them apart.
    syntheticTokens: 0, fixtureCwdTokens: 0, sids: [], syntheticSids: [], cursors: 0, attribution: 0,
    anchorFiles: 0, anchorsVoided: 0, ratesReset: false, dryRun: !!dryRun,
  };

  // ── ① the ledger shards ────────────────────────────────────────────────
  const removedTs = [];      // instants whose cost must no longer be claimed
  const sids = new Set();
  let shardNames = [];
  try { shardNames = fs.readdirSync(historyDir).filter((f) => /^events-\d{4}-\d{2}\.ndjson$/.test(f)).sort(); } catch { }
  for (const name of shardNames) {
    const fp = path.join(historyDir, name);
    let text = ''; try { text = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    const lines = text.split('\n');
    const keep = [], drop = [];
    for (const line of lines) {
      if (!line) continue;
      report.rowsIn++;
      let r = null; try { r = JSON.parse(line); } catch { keep.push(line); continue; } // unparseable stays: we only remove what we can NAME
      const why = fixtureRowReason(r);
      if (!why) { keep.push(line); continue; }
      drop.push({ why, r, line });
      sids.add(r.sid);
      if (typeof r.ts === 'number') removedTs.push(r.ts);
      report.rowsRemoved++;
      report[why === 'synthetic' ? 'synthetic' : 'fixtureCwd']++;
      const tk = why === 'synthetic' ? 'syntheticTokens' : 'fixtureCwdTokens';
      for (const k of ['i', 'o', 'cw5', 'cw1', 'cr']) report[tk] += Number(r[k]) || 0;
    }
    if (!drop.length) continue;
    report.shards++;
    if (dryRun) continue;
    _appendArchive(archiveDir, `fixture-ledger-rows-${_day(now)}.ndjson`, drop.map(({ why, r }) => ({
      migration: id, at: now, store: 'usage-history', file: name,
      reason: why === 'synthetic'
        ? `session id is in the synthetic fixture family — a hand-written transcript, no API request ever happened (sid ${r.sid})`
        : `recorded in a test fixture's throwaway cwd (${r.cwd}); the usage walk refuses that convention from this release, so the ledger no longer counts this class`,
      entry: r,
    })));
    _writeAtomic(fp, keep.length ? keep.join('\n') + '\n' : '');
  }
  // The synthetic ids are the ones a reader needs by name; the rest are real
  // conversation ids from CI-probe turns, so the full list is capped.
  report.syntheticSids = [...sids].filter(isFixtureSid).sort();
  report.sids = [...sids].sort().slice(0, 20);

  // ── ② cursors: entries pointing INTO a fixture project dir ─────────────
  // These are permanent: each run mints a new per-pid cwd, so the map grows by
  // one entry per suite run for ever and never shrinks (221 measured).
  {
    const fp = path.join(historyDir, '_cursors.json');
    const cur = _readJson(fp);
    if (cur && typeof cur === 'object') {
      const dropped = {};
      for (const key of Object.keys(cur)) {
        const parts = String(key).split('/');
        const pi = parts.lastIndexOf('projects');
        const projDir = pi >= 0 ? parts[pi + 1] : null;
        const base = parts[parts.length - 1] || '';
        const sid = base.replace(/\.jsonl(\.zst)?$/, '');
        if ((projDir && isFixtureProjectDir(projDir)) || isFixtureSid(sid)) { dropped[key] = cur[key]; delete cur[key]; }
      }
      report.cursors = Object.keys(dropped).length;
      if (report.cursors && !dryRun) {
        _appendArchive(archiveDir, `fixture-ledger-rows-${_day(now)}.ndjson`, [{
          migration: id, at: now, store: 'usage-history/_cursors.json',
          reason: 'byte cursors for transcripts under a test fixture\'s throwaway cwd — the directories are gone and the walk refuses the convention',
          entry: dropped,
        }]);
        _writeAtomic(fp, JSON.stringify(cur));
      }
    }
  }

  // ── ③ attribution entries naming a synthetic conversation ──────────────
  {
    const fp = path.join(historyDir, 'attribution.ndjson');
    let text = null; try { text = fs.readFileSync(fp, 'utf-8'); } catch { }
    if (text != null) {
      const keep = [], drop = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        let r = null; try { r = JSON.parse(line); } catch { keep.push(line); continue; }
        if (isFixtureSid(r && r.sid)) drop.push(r); else keep.push(line);
      }
      report.attribution = drop.length;
      if (drop.length && !dryRun) {
        _appendArchive(archiveDir, `fixture-ledger-rows-${_day(now)}.ndjson`, drop.map((r) => ({
          migration: id, at: now, store: 'attribution', reason: `billing attribution for a synthetic conversation (sid ${r.sid})`, entry: r,
        })));
        _writeAtomic(fp, keep.length ? keep.join('\n') + '\n' : '');
      }
    }
  }

  // ── ④ the anchors whose costSince measured an interval we just changed ──
  if (removedTs.length) {
    removedTs.sort((a, b) => a - b);
    // Any removed row inside (prevFetchedAt, fetchedAt] made that anchor's
    // costSince too big. Binary-search the sorted instants per anchor.
    const containsRemoved = (from, to) => {
      if (!(from > 0) || !(to > 0) || to <= from) return false;
      let lo = 0, hi = removedTs.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (removedTs[mid] <= from) lo = mid + 1; else hi = mid; }
      return lo < removedTs.length && removedTs[lo] <= to;
    };
    let anchorFiles = [];
    try { anchorFiles = fs.readdirSync(anchorsDir).filter((f) => /^anchors-.*\.ndjson$/.test(f)); } catch { }
    for (const name of anchorFiles) {
      const fp = path.join(anchorsDir, name);
      let text = ''; try { text = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
      const out = []; let voided = 0;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let r = null; try { r = JSON.parse(line); } catch { out.push(line); continue; }
        if (r && r.costSince && containsRemoved(r.prevFetchedAt, r.fetchedAt)) {
          r.costSince = null;
          r.repairedBy = id;
          voided++;
          out.push(JSON.stringify(r));
        } else out.push(line);
      }
      if (!voided) continue;
      report.anchorFiles++; report.anchorsVoided += voided;
      if (!dryRun) _writeAtomic(fp, out.join('\n') + '\n');
    }
    // The learned rates are derived from the pairs we just changed.
    const rates = path.join(anchorsDir, 'rates.json');
    const cur = _readJson(rates);
    if (cur && report.anchorsVoided && !dryRun) {
      _appendArchive(archiveDir, `fixture-ledger-rows-${_day(now)}.ndjson`, [{
        migration: id, at: now, store: 'usage-anchors/rates.json',
        reason: 'learned from anchor pairs whose costSince counted test-fixture rows — re-learned from the cleaned pairs',
        entry: cur,
      }]);
      try { fs.unlinkSync(rates); report.ratesReset = true; } catch { }
    } else if (cur && report.anchorsVoided && dryRun) report.ratesReset = true;
  }

  return report;
}

module.exports = { purgeFixtureLedger, fixtureRowReason };
