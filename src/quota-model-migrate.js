'use strict';
/**
 * quota-model-migrate.js — backfill the TYPED `limits` onto every usage-cache
 * snapshot written before src/quota-model.js existed.
 *
 * WHY A MIGRATION AT ALL, when the write path lifts a legacy file on the fly?
 * Because the lift is a PROJECTION and the projection loses what the legacy
 * shape could not hold. Concretely: a codex file holds ONE limit's buckets, and
 * nothing on it says WHICH limit — `limitId` names whoever wrote last. Until a
 * fresh push arrives (an idle account can be days away), every reader keeps
 * asking a shape that cannot answer "how many limits does this account have".
 * Stamping `limits` once makes the file self-describing immediately, and makes
 * the FIRST push after the upgrade a per-limit merge instead of a replacement.
 *
 * WHAT IT MAY NOT DO. It does not move a number, does not change a `fetchedAt`,
 * does not decide who a reading belongs to (that is the window guard's job and
 * its own migration's), and does not touch the sidecars — `.window-<key>` and
 * `.slot-<id>` are other producers' facts. It is idempotent by construction: a
 * file that already carries `limits` is left alone, and the legacy view it
 * writes back is the projection of what the file already said.
 *
 * ARCHIVE-NEVER-DESTROY: the pre-migration object is appended verbatim to
 * data/archive/quota-model-backfill.ndjson before the file is rewritten, so the
 * old shape is recoverable even though nothing in it is being removed.
 */
const fs = require('fs');
const path = require('path');
const usageWrite = require('./usage-cache-write.js');
const quotaModel = require('./quota-model.js');
const { familyOfScopedBucket } = require('./model-family.js');

/** @returns {{scanned, stamped, already, skipped, limits, byKey}} */
function backfillLimits({ cacheDir, archiveDir, id = 'backfill', log = () => { } }) {
  const res = { scanned: 0, stamped: 0, already: 0, skipped: 0, limits: 0, byKey: {} };
  let names = [];
  try { names = fs.readdirSync(cacheDir); } catch { return res; }
  const archive = [];
  for (const fn of names) {
    // `isCacheFileName` is the product's own predicate: `.json`, never
    // `__models__`, never a sidecar. Using a second spelling here is how a
    // migration ends up repairing a file nothing else reads.
    if (!usageWrite.isCacheFileName(fn)) continue;
    const key = fn.slice(0, -5);
    let cur; try { cur = JSON.parse(fs.readFileSync(path.join(cacheDir, fn), 'utf-8')); } catch { res.skipped++; continue; }
    if (!cur || typeof cur !== 'object') { res.skipped++; continue; }
    res.scanned++;
    if (Array.isArray(cur.limits)) { res.already++; res.byKey[key] = cur.limits.length; res.limits += cur.limits.length; continue; }
    const set = usageWrite.liftCacheObject(cur, { identity: key, familyOf: familyOfScopedBucket });
    const v = quotaModel.validateLimitSet(set);
    if (!v.ok) { res.skipped++; log(`[quota-model] ${key}: cannot lift (${v.errors.join('; ')}) — left untouched`); continue; }
    if (!set.limits.length) { res.skipped++; continue; } // an identity-only remnant states no reading; nothing to stamp
    archive.push({ migration: id, at: Date.now(), store: 'usage-cache', key, entry: cur });
    // REPLACE, not merge: we are stamping what this file ALREADY says. A merge
    // would be a no-op here anyway (prev === next), but saying `replace` makes
    // "this migration moves no number" true by construction rather than by
    // arithmetic that happens to cancel.
    const w = usageWrite.writeCacheObject({ cacheDir, key, obj: cur, set, replace: true, familyOf: familyOfScopedBucket, source: cur.source || null });
    if (!w.ok) { res.skipped++; log(`[quota-model] ${key}: write refused (${w.why})`); continue; }
    res.stamped++; res.limits += set.limits.length; res.byKey[key] = set.limits.length;
  }
  if (archive.length && archiveDir) {
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.appendFileSync(path.join(archiveDir, 'quota-model-backfill.ndjson'), archive.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch { }
  }
  return res;
}

module.exports = { backfillLimits };
