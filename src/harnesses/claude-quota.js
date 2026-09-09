'use strict';
// CLAUDE QuotaSignalSource (harness S4, docs/design-harness-plugins.md §2.4):
// how the claude harness reports quota, in one object the engine reaches
// through the harness registry (never a backend-id branch). Contract:
//   normalize(raw, nowMs)      → {fiveHour, sevenDay, scopedWeekly, …} | null
//   signalFromStream(record)   → a typed wall/quota signal | null
//   probe                      → capsOf(id).quotaProbe rung name | null
//   classifyAuthFailure(info)  → boolean
// SHARED tier: pure parsers over what the CLI already emitted — nothing here
// may ever ORIGINATE a vendor call (§ban-safety; test-vendor-whitelist).
//
// The three claude reading shapes and their parsers (all moved/bound here so
// the registry is the single source; usage-routes re-exports the names):
//   • `claude -p /usage` panel TEXT       → parseCliUsageText   (2.327.0, moved verbatim)
//   • GET /api/oauth/usage JSON           → parseOAuthUsage     (usage-routes _parseUsage, moved verbatim)
//   • get_usage control payload           → ClaudeCodeAdapter.parseGetUsageResponse (adapter, unchanged)
const { capsOf } = require('../backend-caps.js');
const { ClaudeCodeAdapter } = require('../adapters/claude-code.js');
const { parseRateLimitEvent } = require('../rate-limit-capture.js');
const { classifyAuthFailure } = require('../account-pool-auto.js');

// ── `claude -p /usage` output parser (2.327.0, user-verified channel) ──
// The CLI's own /usage panel is the ONLY quota source that carries ALL THREE
// buckets (5h + 7d + model-scoped weeklies) without a live chat session and
// without this server touching the vendor API — the CLI makes the fetch as
// the first party, exactly like the user typing /usage. Text format pinned by
// scripts/test-cli-usage-parse.mjs against a captured real output; any parse
// failure returns null and the ladder falls through to the token read.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function zonedEpoch(y, mon, d, h, min, tz) {
  // epoch for wall-clock (y,mon,d,h,min) IN tz: guess as UTC, then correct by
  // the zone's offset at that instant (second pass absorbs DST boundaries)
  let t = Date.UTC(y, mon, d, h, min);
  for (let i = 0; i < 2; i++) {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false })
        .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      const asIf = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute);
      t += Date.UTC(y, mon, d, h, min) - asIf;
    } catch { return null; }
  }
  return Math.floor(t / 1000);
}
function _parseCliResetTime(when, tz, nowMs) {
  // "Aug 12, 12:20am" / "Aug 13, 2am"
  const m = /^(\w{3})\w*\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(String(when).trim());
  if (!m || !(m[1].toLowerCase() in MONTHS)) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  let h = +m[3] % 12; if (/pm/i.test(m[5])) h += 12;
  const now = new Date(nowMs || Date.now());
  let y = now.getUTCFullYear();
  let t = zonedEpoch(y, mon, +m[2], h, +(m[4] || 0), tz);
  if (t == null) return null;
  // resets are always in the future ≤ ~8 days out; a January reset read in
  // late December belongs to NEXT year
  if (t * 1000 < (nowMs || Date.now()) - 6 * 3600e3) t = zonedEpoch(y + 1, mon, +m[2], h, +(m[4] || 0), tz);
  return t;
}
function parseCliUsageText(text, nowMs) {
  const s = String(text || '');
  const line = (re) => re.exec(s);
  const bucket = (m) => m && {
    utilization: Math.min(1, Math.max(0, (+m[1]) / 100)),
    ...(m[2] && m[3] ? { resetsAt: _parseCliResetTime(m[2], m[3], nowMs) || undefined } : {}),
  };
  const fiveHour = bucket(line(/^Current session:\s+(\d+)% used(?:\s*·\s*resets\s+(.+?)\s+\(([\w/_+-]+)\))?/m));
  const sevenDay = bucket(line(/^Current week \(all models\):\s+(\d+)% used(?:\s*·\s*resets\s+(.+?)\s+\(([\w/_+-]+)\))?/m));
  if (!fiveHour && !sevenDay) return null; // API-key mode / format drift — not a subscription usage panel
  const scopedWeekly = [];
  for (const m of s.matchAll(/^Current week \(([^)]+)\):\s+(\d+)% used(?:\s*·\s*resets\s+(.+?)\s+\(([\w/_+-]+)\))?/gm)) {
    if (/^all models$/i.test(m[1])) continue;
    scopedWeekly.push({ name: m[1], utilization: Math.min(1, Math.max(0, (+m[2]) / 100)),
      ...(m[3] && m[4] ? { resetsAt: _parseCliResetTime(m[3], m[4], nowMs) || undefined } : {}) });
  }
  return { fiveHour: fiveHour || undefined, sevenDay: sevenDay || undefined, scopedWeekly, fetchedAt: nowMs || Date.now() };
}

// GET /api/oauth/usage reply → usage-cache shape (usage-routes `_parseUsage`,
// moved verbatim; the route + device-op consumers bind the same function).
function parseOAuthUsage(u) {
  // Frontend expects utilization as a 0–1 fraction and resetsAt as unix
  // seconds; the endpoint gives a 0–100 percent and an ISO timestamp.
  const toWin = (w) => (w && typeof w === 'object') ? {
    utilization: (typeof w.utilization === 'number' ? w.utilization : 0) / 100,
    status: (typeof w.utilization === 'number' && w.utilization >= 100) ? 'limited' : 'allowed',
    resetsAt: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) || 0 : 0,
  } : { utilization: 0, status: 'unknown', resetsAt: 0 };
  const fiveHour = toWin(u.five_hour);
  const sevenDay = toWin(u.seven_day);
  const scopedWeekly = [];
  const haveScoped = new Set();
  if (Array.isArray(u.limits)) {
    for (const lim of u.limits) {
      if (lim?.kind === 'weekly_scoped' && lim.scope?.model?.display_name) {
        scopedWeekly.push({
          name: lim.scope.model.display_name,
          utilization: (typeof lim.percent === 'number' ? lim.percent : 0) / 100,
          resetsAt: lim.resets_at ? Math.floor(Date.parse(lim.resets_at) / 1000) || 0 : 0,
          severity: lim.severity || 'normal',
        });
        haveScoped.add(String(lim.scope.model.display_name).toLowerCase());
      }
    }
  }
  // NAMED scoped buckets too (2.305.0, inc-msof8i22): the REST payload can
  // carry a model-scoped weekly as a top-level `seven_day_opus`-style field
  // instead of (or in addition to) a `limits[]` entry. Reading only limits[]
  // made the OPUS cap invisible to the pool's exhaustion test — it stayed on
  // an account whose Opus was spent while a member still had headroom. Any
  // object field with a utilization/percent AND a reset counts; array entries
  // win on name collision.
  for (const [k, v] of Object.entries(u)) {
    if (!/^seven_day_./.test(k) || k === 'seven_day_oauth_apps') continue;
    if (!v || typeof v !== 'object') continue;
    const pctRaw = typeof v.utilization === 'number' ? v.utilization
      : (typeof v.percent === 'number' ? v.percent : null);
    if (pctRaw == null || !v.resets_at) continue;
    const name = k.replace(/^seven_day_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (haveScoped.has(name.toLowerCase())) continue;
    haveScoped.add(name.toLowerCase());
    const util = pctRaw > 1 ? pctRaw / 100 : pctRaw;
    scopedWeekly.push({
      name, utilization: util,
      resetsAt: v.resets_at ? Math.floor(Date.parse(v.resets_at) / 1000) || Number(v.resets_at) || 0 : 0,
      severity: util >= 1 ? 'exceeded' : (v.severity || 'normal'),
    });
  }
  // extra_usage → spend (B-87fe; guards mirror claude-swap oauth.py:419-441).
  // used_credits/monthly_limit are cents; monthly_limit=null means unlimited
  // (skip the limit, keep spend). All-or-nothing on the three core fields so a
  // partial payload never renders a half-baked spend line.
  let spend = null;
  const eu = u.extra_usage;
  if (eu && eu.is_enabled) {
    const uc = eu.used_credits, ml = eu.monthly_limit, ut = eu.utilization;
    if (uc != null && ut != null) {
      spend = {
        used: Number(uc) / 100,
        limit: ml != null ? Number(ml) / 100 : null, // null = unlimited
        pct: Number(ut),
        currency: eu.currency || 'USD',
        resetsAt: eu.resets_at ? Math.floor(Date.parse(eu.resets_at) / 1000) || 0 : 0,
      };
    }
  }
  return {
    fiveHour, sevenDay, scopedWeekly, ...(spend ? { spend } : {}),
    overallStatus: (fiveHour.status === 'limited' || sevenDay.status === 'limited') ? 'limited' : 'allowed',
    fetchedAt: Date.now(),
  };
}

// ONE entry over the three claude reading shapes (the harness contract).
// Dispatch is by SHAPE, never by caller: a string is the CLI panel text; an
// object carrying `rate_limits` is the get_usage control payload; an object
// carrying the REST window fields is the OAuth usage reply. Anything else is
// not a claude quota reading → null (never a fabricated bucket).
function normalize(raw, nowMs) {
  if (typeof raw === 'string') return parseCliUsageText(raw, nowMs);
  if (!raw || typeof raw !== 'object') return null;
  if (raw.rate_limits && typeof raw.rate_limits === 'object') return ClaudeCodeAdapter.parseGetUsageResponse(raw);
  if (raw.five_hour || raw.seven_day || Array.isArray(raw.limits)) return parseOAuthUsage(raw);
  return null;
}

// The chat-mode banner regex session-stdout gates on (2.260.0) — the banner
// is a BOOLEAN wall signal (design-wall-machine §1: text is never a data
// source); parseLimitBanner names the bucket for the passive cache mark only.
const LIMIT_BANNER_RE = /You've (?:reached|hit) your .{0,40} limit/;

// Classify one stream-json record. Returns null for anything that is not a
// quota/wall signal.
//   {source:'rate_limit_event', kind:'exhausted'|'reading'|'meta', bucket, scopedName, resetsAtMs, ev}
//   {source:'limit-banner',     kind:'exhausted', bucket, scopedName, resetsAtMs:0, text}
function signalFromStream(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.type === 'rate_limit_event') {
    const ev = parseRateLimitEvent(record);
    if (!ev) return null;
    const kind = ev.status === 'rejected' ? 'exhausted' : (ev.utilization != null ? 'reading' : 'meta');
    return { source: 'rate_limit_event', kind, bucket: ev.kind, scopedName: ev.scopedName || null, resetsAtMs: (Number(ev.resetsAt) || 0) * 1000, ev };
  }
  if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
    for (const b of record.message.content) {
      if (b?.type !== 'text' || typeof b.text !== 'string' || !LIMIT_BANNER_RE.test(b.text)) continue;
      const hit = ClaudeCodeAdapter.parseLimitBanner(b.text);
      if (!hit) continue;
      return { source: 'limit-banner', kind: 'exhausted', bucket: hit.kind, scopedName: hit.name || null, resetsAtMs: 0, text: b.text };
    }
  }
  return null;
}

/** Weekly windows (7-day + model-scoped weekly) reset on a FIXED per-account
 *  anchor: every reset is exactly 7 days after the previous one. When a
 *  reading carries no reset time (the CLI's /usage panel omits it while a
 *  bucket sits at 0%), the next reset is still knowable from the last one we
 *  observed — deterministic, owner-asked 2.369.33. Returns unix seconds of the
 *  first prev + k·period strictly in the future, or null. 5-hour windows are
 *  NOT projectable (they start with the first request), so callers never
 *  pass those here. */
function projectReset(prevResetsAt, periodSec, nowSec) {
  const prev = Number(prevResetsAt) || 0, period = Number(periodSec) || 0;
  if (!prev || period <= 0) return null;
  const now = Number(nowSec) || Math.floor(Date.now() / 1000);
  if (prev > now) return prev;
  const k = Math.floor((now - prev) / period) + 1;
  return prev + k * period;
}
const WEEK_SEC = 7 * 86400;

// ── THE TYPED LIMIT SET (src/quota-model.js) ────────────────────────────────
// Every claude reading shape becomes ONE typed set, so the write path and every
// reader see the same object no matter which of the four channels produced it.
// The claude account holds:
//   • ONE plan limit (`plan`) with a '5h' and a '7d' window,
//   • ONE model-scoped limit PER `scopedWeekly` entry — measured on this
//     instance, exactly one exists (Fable; owner: "除了 fable，没有模型 specific
//     的用量限制的"), but the shape is a LIST because the vendor's payload is,
//   • an `overage` limit when the account carries extra usage (`spend`, from
//     `extra_usage`) or an overage state (`rate_limit_event`'s overage fields).
// `familyOf` is injected by the caller (src/model-family.js) — this file is in
// the SHARED tier and quota-model is PURE, so neither may reach for it.
const quotaModel = require('../quota-model.js');

const CLAUDE_EXTRA_KEYS = ['orgUuid', 'orgName', 'orgEmail', 'email', 'name', 'planType', 'overallStatus', 'scopedFetchedAt', 'spend', 'corroborated'];

/** One claude reading (any of the four shapes) → a typed LimitSet.
 *  `raw` is either a raw payload `normalize()` understands, or an already
 *  normalized snapshot (the historical cache shape). Returns null when the
 *  payload is not a claude quota reading at all — never a fabricated set. */
function toLimitSet(raw, { identity = null, source = null, nowMs = null, familyOf = null } = {}) {
  const at = Number(nowMs) || Date.now();
  const snap = (raw && typeof raw === 'object' && (raw.fiveHour || raw.sevenDay || Array.isArray(raw.scopedWeekly)))
    ? raw : normalize(raw, at);
  if (!snap) return null;
  const set = quotaModel.fromLegacy(snap, {
    identity, source: source || snap.source || null, fetchedAt: snap.fetchedAt || at,
    limitId: 'plan', familyOf, extraKeys: CLAUDE_EXTRA_KEYS,
  });
  // EXTRA USAGE IS ITS OWN LIMIT, not a footnote on the plan. `spend` is REAL
  // DOLLARS past the subscription allowance: with overage on, utilization stays
  // under 1 while every token is billed, so an account ranked on utilization
  // alone looks like the member with the MOST headroom (design §1.4). Modelling
  // it as a limit is what lets a reader ask about it at all.
  const sp = snap.spend;
  if (sp && typeof sp === 'object' && (Number.isFinite(Number(sp.used)) || Number.isFinite(Number(sp.pct)))) {
    const pct = Number(sp.pct);
    const win = quotaModel.makeWindow({
      kind: 'monthly', minutes: 0,
      usedPct: Number.isFinite(pct) ? Math.max(0, Math.min(100, pct <= 1 ? pct * 100 : pct)) : null,
      resetsAt: sp.resetsAt, measuredAt: at,
    });
    const i = set.limits.findIndex((l) => l.limitId === 'overage');
    const flags = { ...(i >= 0 ? set.limits[i].flags : {}), used: Number(sp.used), limit: sp.limit == null ? null : Number(sp.limit), currency: sp.currency || 'USD' };
    const lim = quotaModel.makeLimit({ limitId: 'overage', scope: 'overage', name: 'Extra usage', windows: [win], flags, source: set.source, fetchedAt: at });
    if (i >= 0) set.limits[i] = quotaModel.mergeLimit(set.limits[i], lim); else set.limits.push(lim);
  }
  return set;
}

/** ONE parsed `rate_limit_event` → a typed set carrying exactly ONE limit with
 *  exactly ONE window. That is the honest shape: the record names one bucket,
 *  and `mergeLimitSets` is what puts it back beside the others without
 *  disturbing them (the per-bucket `applyTo` this replaces had to hand-preserve
 *  every field it was not writing — five fields have been lost that way). */
function limitSetFromEvent(ev, { identity = null, source = 'rate-limit-event', nowMs = null, familyOf = null } = {}) {
  if (!ev || (ev.kind !== 'fiveHour' && ev.kind !== 'sevenDay' && ev.kind !== 'scoped')) return null;
  const at = Number(nowMs) || Date.now();
  const dead = ev.status === 'rejected';
  // A REJECTION IS A READING OF 100 %, and its window is whatever the record
  // stated — never a guess here. (The bounded `now + 5h/24h` guess the cache
  // writer makes when a rejection states no reset stays in the write path,
  // where the previous value is in hand to prefer first.)
  const usedPct = dead ? 100 : (ev.utilization != null ? Math.max(0, Math.min(1, ev.utilization)) * 100 : null);
  const status = dead ? 'limited' : (ev.status || null);
  const kind = ev.kind === 'fiveHour' ? '5h' : '7d';
  const win = quotaModel.makeWindow({ kind, usedPct, resetsAt: ev.resetsAt, measuredAt: at, status });
  const limits = [];
  if (ev.kind === 'scoped') {
    const name = String(ev.scopedName || '');
    limits.push(quotaModel.makeLimit({
      limitId: 'model:' + name.toLowerCase().replace(/\s+/g, '-'), name, scope: 'model',
      model: name, family: familyOf ? familyOf(name) : null,
      windows: [win], flags: { asOf: at }, source, fetchedAt: at,
    }));
  } else {
    limits.push(quotaModel.makeLimit({ limitId: 'plan', scope: 'plan', windows: [win], source, fetchedAt: at }));
  }
  if (ev.overage && Object.values(ev.overage).some((v) => v !== undefined)) {
    limits.push(quotaModel.makeLimit({ limitId: 'overage', scope: 'overage', name: 'Extra usage', windows: [], flags: { ...ev.overage, asOf: at }, source, fetchedAt: at }));
  }
  return quotaModel.makeLimitSet({ identity, fetchedAt: at, source, limits });
}

module.exports = { projectReset, WEEK_SEC,
  normalize,
  signalFromStream,
  probe: capsOf('claude').quotaProbe, // 'cli-usage': the `claude -p /usage` auto-cli rung (usage-routes refreshViaCliPanel)
  classifyAuthFailure,               // account-pool-auto's Anthropic-wording classifier, verbatim
  // THE TYPED PRODUCERS (src/quota-model.js) — the write path takes these.
  // `limitSetFromSnapshot` is the HARNESS-NEUTRAL name the engine dispatches on
  // (`quotaSourceFor(backend).limitSetFromSnapshot`), never a backend-id branch:
  // for claude a normalized snapshot IS one of the shapes toLimitSet accepts.
  toLimitSet, limitSetFromEvent, CLAUDE_EXTRA_KEYS,
  limitSetFromSnapshot: (snap, opts) => toLimitSet(snap, opts),
  // named helpers for current callers / tests
  parseCliUsageText, parseOAuthUsage, LIMIT_BANNER_RE,
};
