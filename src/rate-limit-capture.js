'use strict';
/**
 * rate-limit-capture.js — passive quota capture from the CLI's own
 * `rate_limit_event` stream-json records (B-e5c9, discovered by binary
 * forensics on 2.1.226: a first-class stdout record type "emitted when rate
 * limit info changes", riding real API responses — VibeSpace dropped it as
 * an unknown type since forever).
 *
 * WHY IT MATTERS: chat/stream-json sessions have no statusline, so their
 * accounts' quota showed last-known only. This record closes that gap with
 * ZERO extra API calls (§ban-safety: purely passive — nothing here may ever
 * originate a vendor call), and `status:"rejected"` is a STRUCTURED
 * exhaustion signal (the banner-text parse's typed sibling). Utilization
 * readings become dead-reckoning anchors for free (the anchors sweep treats
 * any usage-cache write as ground truth).
 *
 * ONE implementation for every machine (CS rule): the server calls this for
 * local AND remote chat sessions (remote stdout relays through the same
 * parse), and the module is deliberately dependency-free (fs/path only) so
 * the device daemon can bundle it when session.events moves device-side.
 *
 * Fields (builder `wFb` in the 2.1.226 binary): status(allowed/rejected)/
 * resetsAt/rateLimitType/utilization/overageStatus/overageResetsAt/
 * overageDisabledReason/isUsingOverage/overageInUse/surpassedThreshold/
 * rateLimitGraceActive/overagePeriodMonthly/overagePeriodChannel/errorCode/
 * canUserPurchaseCredits/hasChargeableSavedPaymentMethod. All optional —
 * real captured samples carried only status+resetsAt+type+overage.
 */
const fs = require('fs');
const path = require('path');

/** Normalize one stream-json record. Returns null for anything else.
 *  Accepts both key casings defensively (the 2.227.6 rule — this record is
 *  stdout-only today, but a future JSONL copy would be camelCase-at-top). */
function parseRateLimitEvent(msg) {
  if (!msg || msg.type !== 'rate_limit_event') return null;
  const info = msg.rate_limit_info || msg.rateLimitInfo;
  if (!info || typeof info !== 'object') return null;
  const rawType = String(info.rateLimitType ?? info.rate_limit_type ?? '') || null;
  // ④ of the 2.340.0 calibration batch: seven_day_<model> types are the ONLY
  // passive channel for scoped weekly buckets (statusline exports 5h/7d only,
  // binary-verified vs claude 2.1.229) — map them to scoped readings instead
  // of dropping to 'other', so warnings/rejections anchor the scoped
  // estimator (its -45% burst error traced directly to anchor starvation).
  const scopedM = /^seven_day_(?!overage)(\w+)$/.exec(rawType || '');
  // seven_day_overage_included IS the weekly lane — it's the accounting the
  // CLI actually enforces on once extra usage exists (usage vs limit+credits).
  // Live incident (2026-08-20, the "monthly spend limit" reject): mapping it
  // to 'other' meant a REJECTED weekly+monthly-cap event was surfaced but
  // never marked — the 7d cache stayed at 0.53 and the pool kept re-picking a
  // member that was hard-dead until its reset.
  const kind = rawType === 'five_hour' ? 'fiveHour'
    : (rawType === 'seven_day' || rawType === 'weekly' || rawType === 'seven_day_overage_included') ? 'sevenDay'
      : scopedM ? 'scoped'
        : rawType ? 'other' : null;
  let u = info.utilization ?? info.used_percentage;
  if (typeof u === 'number' && u > 1.5) u = u / 100; // integer % (get_usage precedent)
  const resetsAt = Number(info.resetsAt ?? info.resets_at) || null;
  return {
    kind, rawType, scopedName: scopedM ? scopedM[1] : null,
    status: String(info.status || '') || null, // allowed | rejected | (future values pass through)
    utilization: (typeof u === 'number' && u >= 0) ? Math.min(u, 1) : null,
    resetsAt,
    overage: {
      status: info.overageStatus ?? info.overage_status,
      resetsAt: info.overageResetsAt ?? info.overage_resets_at,
      disabledReason: info.overageDisabledReason ?? info.overage_disabled_reason,
      inUse: info.isUsingOverage ?? info.is_using_overage ?? info.overageInUse,
    },
    surpassedThreshold: info.surpassedThreshold ?? info.surpassed_threshold,
  };
}

/**
 * Write one parsed event into the usage cache with the SAME identity-group
 * discipline markLimitBanner earned in 2.267.0 (anchor-poison root cause):
 * base the primary write on the identity's FRESHEST file; mark the bucket in
 * every sibling WITHOUT touching its fetchedAt; never CREATE a sibling.
 *
 * fetchedAt DISCIPLINE (the anti-poison rule this module adds): bump it ONLY
 * when the event carried a real READING (a utilization, or rejected ⇒ dead
 * bucket = utilization 1). A resetsAt/overage-only event updates bucket
 * fields in place but must NOT promote the file to "freshest" — the anchors
 * sweep would otherwise re-anchor stale utilization with fresh cost (the
 * exact bounce-pair poison 2.267.0 fixed).
 *
 * `source` (default 'rate-limit-event') labels the reading write — the wall
 * machine's ground-truth demotion (B-2c9b) rides this SAME path with source
 * 'wall' so anchors/estimator/verdicts see one write discipline, never a twin.
 *
 * @returns {ok, dead, wroteReading} — dead=true when the bucket is exhausted
 *   (caller should treat it like a limit banner: immediate pool evaluation).
 */
function captureRateLimitEvent({ cacheDir, key, identityIds, ev, now = Date.now(), source = 'rate-limit-event' }) {
  if (!ev || (ev.kind !== 'fiveHour' && ev.kind !== 'sevenDay' && ev.kind !== 'scoped')) {
    // unknown bucket types: surface, never silently drop (the api_retry lesson)
    return { ok: false, dead: false, wroteReading: false, unknownType: ev?.rawType || null };
  }
  const dead = ev.status === 'rejected';
  const reading = dead || ev.utilization != null;
  const nowSec = Math.floor(now / 1000);
  const applyTo = (cache) => {
    if (ev.kind === 'scoped') {
      const list = Array.isArray(cache.scopedWeekly) ? cache.scopedWeekly.slice() : [];
      const i = list.findIndex((s) => String(s.name || '').toLowerCase() === ev.scopedName);
      const s = { ...(i >= 0 ? list[i] : { name: ev.scopedName }) };
      if (ev.status === 'rejected') { s.utilization = 1; s.status = 'limited'; }
      else if (ev.utilization != null) { s.utilization = ev.utilization; s.status = ev.status || s.status; }
      else if (ev.status) s.status = ev.status;
      if (Number(ev.resetsAt) > 0) s.resetsAt = ev.resetsAt;
      s.asOf = now; // fresh reading marker — the scoped pair guard keys on asOf
      if (i >= 0) list[i] = s; else list.push(s);
      cache.scopedWeekly = list;
      return cache; // primary write path consumes the return value
    }
    const b = { ...(cache[ev.kind] || {}) };
    if (dead) {
      b.utilization = 1; b.status = 'limited';
      b.resetsAt = (Number(ev.resetsAt) || 0) > nowSec ? ev.resetsAt
        : (Number(b.resetsAt) || 0) > nowSec ? b.resetsAt
          : nowSec + (ev.kind === 'fiveHour' ? 5 * 3600 : 24 * 3600); // bounded guess — self-expires
    } else {
      if (ev.utilization != null) { b.utilization = ev.utilization; b.status = ev.status || b.status; }
      else if (ev.status) b.status = ev.status;
      if ((Number(ev.resetsAt) || 0) > 0) b.resetsAt = ev.resetsAt;
    }
    cache[ev.kind] = b;
    if (ev.overage && Object.values(ev.overage).some((v) => v !== undefined)) cache.overage = { ...(cache.overage || {}), ...ev.overage, asOf: now };
    return cache;
  };
  const fileFor = (id) => path.join(cacheDir, String(id).replace(/[^\w.-]/g, '_') + '.json');
  const ids = (identityIds && identityIds.length ? identityIds : [key]);
  try {
    let base = null, baseAt = -1;
    for (const id of ids) {
      try { const c = JSON.parse(fs.readFileSync(fileFor(id), 'utf-8')) || {}; if ((Number(c.fetchedAt) || 0) > baseAt) { baseAt = Number(c.fetchedAt) || 0; base = c; } } catch { }
    }
    const cache = applyTo(base ? { ...base } : {});
    if (reading) { cache.fetchedAt = now; cache.source = source || 'rate-limit-event'; }
    fs.mkdirSync(cacheDir, { recursive: true });
    const f = fileFor(key);
    fs.writeFileSync(f + '.tmp', JSON.stringify(cache)); fs.renameSync(f + '.tmp', f);
    for (const id of ids) {
      if (id === key) continue;
      try {
        let c2; try { c2 = JSON.parse(fs.readFileSync(fileFor(id), 'utf-8')) || null; } catch { c2 = null; }
        if (!c2) continue; // never create a sibling
        applyTo(c2); // fetchedAt deliberately untouched
        fs.writeFileSync(fileFor(id) + '.tmp', JSON.stringify(c2)); fs.renameSync(fileFor(id) + '.tmp', fileFor(id));
      } catch { }
    }
    return { ok: true, dead, wroteReading: reading };
  } catch (e) {
    return { ok: false, dead, wroteReading: false, error: e.message };
  }
}

module.exports = { parseRateLimitEvent, captureRateLimitEvent };
