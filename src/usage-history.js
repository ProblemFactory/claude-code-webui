/**
 * UsageHistory — a PERMANENT, append-only ledger of per-request token usage,
 * mined from Claude Code's own JSONL transcripts (the same file for terminal
 * AND chat sessions, so coverage is mode-independent).
 *
 * WHY a separate ledger: the CLI's transcripts get rotated/deleted; this ledger
 * keeps the atomic facts forever so ANY future analysis is just a read. Each
 * line is one API REQUEST (deduped by requestId — a single request appears on
 * 2-3 JSONL records with identical usage; summing raw records double-counts).
 *
 * Incremental: per-file {offset,lastRid} cursor → only new bytes are parsed, so
 * scanning stays O(new data) even across hundreds of MB of history.
 *
 * Attribution: the JSONL basename is the immutable session id; session-meta maps
 * it to account/mode/host. cwd comes from the record itself.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { runUsageWalk } = require('./usage-walker.js');

// API-equivalent prices, USD per MILLION tokens. Subscription sessions don't
// actually cost this — it's shown as a reference ("what this would cost on the
// API"). Official Anthropic pricing per platform.claude.com/docs/.../pricing,
// as of 2026-07-09 (researched + cross-verified). Tier matched by substring of
// the model id (current flagship rates; deprecated Opus 4.1/4 were $15/$75 —
// override per-account in pricing.json if you still run those). Editable at
// data/usage-history/pricing.json.
const DEFAULT_PRICING = {
  // Fable 5 — $10/$50 (2× Opus; Mythos-class). NOTE: Fable uses a newer tokenizer
  // (~30% more tokens per unit of English text), so effective $/word is higher.
  fable:  { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1.0 },
  opus:   { input: 5,  output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },  // Opus 4.5–4.8
  sonnet: { input: 3,  output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6,  cacheRead: 0.3 },  // standard (intro $2/$10 through 2026-08-31)
  haiku:  { input: 1,  output: 5,  cacheWrite5m: 1.25, cacheWrite1h: 2,  cacheRead: 0.1 },
  // OpenAI (codex) — per developers.openai.com pricing as of 2026-07-09 (GPT-5.6
  // GA'd today: Sol $5/$30, Terra $2.50/$15, Luna $1/$6; 5.5 $5/$30; 5.4
  // $2.50/$15; 5.4-mini $0.75/$4.50; 5.3-codex $1.75/$14). cacheRead = the 90%-
  // off cached-input rate. cacheWrite 0: codex rollouts don't report cache-write
  // token counts, so those events always carry cw=0 — a price would never apply.
  // Tier match is LONGEST-substring over these keys, so 'gpt-5.6-sol' wins over
  // any shorter overlap; a new model = one new key here or in pricing.json.
  'gpt-5.6-sol':   { input: 5,    output: 30,   cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.5 },
  'gpt-5.6-terra': { input: 2.5,  output: 15,   cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.25 },
  'gpt-5.6-luna':  { input: 1,    output: 6,    cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.1 },
  'gpt-5.5':       { input: 5,    output: 30,   cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.5 },
  'gpt-5.4-mini':  { input: 0.75, output: 4.5,  cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.075 },
  'gpt-5.4':       { input: 2.5,  output: 15,   cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.25 },
  'gpt-5.3':       { input: 1.75, output: 14,   cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.175 },
  _default: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
};

class UsageHistory {
  // resolveAccount(acctId) → { type:'subscription'|'api'|'codex-subscription', name, tail } | null
  // Lets the ledger BAKE which account (and its billing TYPE) each request used,
  // so subscription usage (plan quota) and API-key usage (real $) never mix, and
  // the label survives even if the account is later deleted.
  constructor({ dataDir, homeDir = os.homedir(), resolveAccount = () => null }) {
    this.dir = path.join(dataDir, 'usage-history');
    this.metaDir = path.join(dataDir, 'session-meta');
    this.projectsDir = path.join(homeDir, '.claude', 'projects');
    this.codexSessionsDir = path.join(process.env.CODEX_HOME || path.join(homeDir, '.codex'), 'sessions');
    this.cursorsFile = path.join(this.dir, '_cursors.json');
    this.pricingFile = path.join(this.dir, 'pricing.json');
    this.attribFile = path.join(this.dir, 'attribution.ndjson');
    this._resolveAccount = resolveAccount;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
    this._cursors = this._loadJson(this.cursorsFile, {});
    this._pricing = this._loadPricing();
    this._scanning = false;
    this._lastScan = 0;
  }

  // ── Account attribution log (append-only, PERMANENT) ────────────────────────
  // VibeSpace appends {sid, acct, ts} whenever it spawns/resumes a session under
  // a known account + known claudeSessionId. A session RESUMED under a different
  // account is then attributed per-request by TIME (the account active when each
  // request happened), not just the latest — so switching accounts mid-session
  // never mixes the billing. session-meta's current accountId is the fallback.
  // `pool` (optional) tags the POOLED pseudo-account a request was billed
  // THROUGH — acct still holds the pool's REAL target at that time (so per-
  // account and the global sum stay correct with no double-count), pool is an
  // extra dimension so the Usage window can also show the total that flowed
  // through each pool.
  recordAttribution({ sid, acct, pool, ts }) {
    if (!sid) return;
    try { fs.appendFileSync(this.attribFile, JSON.stringify({ sid, acct: acct || null, pool: pool || null, ts: ts || Date.now() }) + '\n'); } catch {}
    this._attrib = null; // invalidate cache
  }
  _attribMap() {
    if (this._attrib) return this._attrib;
    const map = {};
    let data = ''; try { data = fs.readFileSync(this.attribFile, 'utf-8'); } catch {}
    for (const line of data.split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!e.sid) continue;
      (map[e.sid] = map[e.sid] || []).push({ ts: e.ts || 0, acct: e.acct || null, pool: e.pool || null });
    }
    for (const sid of Object.keys(map)) map[sid].sort((a, b) => a.ts - b.ts);
    this._attrib = map;
    return map;
  }
  // The account active for session `sid` at time `ts` — latest attribution entry
  // whose ts <= the request, else the meta fallback.
  _acctAt(sid, ts, attrib, metaAcct) {
    const list = attrib[sid];
    if (list && list.length) {
      // A global-login entry legitimately stores acct=null, so track WHETHER an
      // entry matched (found) separately from its value — otherwise a null match
      // followed by a later account switch would fall through to metaAcct and
      // mis-bill a global-login request to the later account.
      let found = false, chosen = null;
      for (const e of list) { if (e.ts <= ts) { found = true; chosen = e.acct; } else break; }
      if (found) return chosen;                 // exact account active at that time (may be null = global)
      // Request predates the first attribution entry. A small grace window
      // covers spawn-ordering skew (first request can land seconds before the
      // meta write). Anything older genuinely happened before this session was
      // ever bound to an account → global. Returning list[0].acct here billed
      // a week of pre-registration usage to a newly added subscription (the
      // initial ledger backfill ran AFTER the account was attached).
      return ts >= list[0].ts - 10 * 60 * 1000 ? list[0].acct : null;
    }
    return metaAcct || null;
  }
  // The POOLED pseudo-account (if any) active for session `sid` at time `ts` —
  // same by-time walk as _acctAt but returns the pool tag. Baked onto events so
  // the Usage window can show per-pool totals without a second attribution pass.
  _poolAt(sid, ts, attrib) {
    const list = attrib[sid];
    if (!list || !list.length) return null;
    let found = false, chosen = null;
    for (const e of list) { if (e.ts <= ts) { found = true; chosen = e.pool || null; } else break; }
    if (found) return chosen;
    return ts >= list[0].ts - 10 * 60 * 1000 ? (list[0].pool || null) : null;
  }

  // Public attribution view for one instant (OTel truth ingest compares the
  // observed org against this before writing a corrective record).
  attribAt(sid, ts) {
    const attrib = this._attribMap();
    const list = attrib[sid];
    return {
      acct: this._acctAt(sid, ts, attrib, null),
      pool: this._poolAt(sid, ts, attrib),
      // newest entry ts for the sid — corrective truth records bump past it
      // so a late-flushed observation still dominates the walk going forward
      lastTs: list && list.length ? list[list.length - 1].ts : 0,
    };
  }
  // OBSERVED-truth override for the bake (2.361.0, B-345b): fn(rid) →
  // accountId|null (null = machine global login) | undefined (no truth →
  // fall back to the attribution walk). Wired to otel-ingest.truthLookup —
  // the CLI's own api_request telemetry names the org that ACTUALLY billed a
  // request, which the link-intent attribution gets wrong for up to a token
  // lifetime after a pool hot-switch (the stale-token forensics).
  setTruthLookup(fn) { this._truthLookup = typeof fn === 'function' ? fn : null; }

  _loadJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fallback; } }
  // Pricing schema v2: { version, tiers:{opus,sonnet,haiku,fable,_default}, accounts:{ <id>: {discount} | {tiers:{...}} } }.
  // Subscriptions use the default tiers (the "API-equivalent" reference). API-key
  // accounts can carry a per-account DISCOUNT (negotiated rate) or a full tier
  // override — because different keys really do bill at different rates.
  _loadPricing() {
    let p = this._loadJson(this.pricingFile, null);
    if (!p) {
      p = { version: 2, tiers: DEFAULT_PRICING, accounts: {} };
      // atomic like every other pricing write — a crash mid-write tears the
      // file and the next boot's _loadJson fallback silently recreates
      // defaults over user-edited rates
      try { this._writeAtomic(this.pricingFile, JSON.stringify(p, null, 2)); } catch {}
    } else if (!p.tiers) {
      // migrate the old FLAT {opus:{...},...} file to v2 in place
      p = { version: 2, tiers: p, accounts: {} };
      try { this._writeAtomic(this.pricingFile, JSON.stringify(p, null, 2)); } catch {}
    }
    if (!p.accounts) p.accounts = {};
    if (!p.tiers) p.tiers = DEFAULT_PRICING;
    // Newly-shipped default tiers (e.g. the gpt-* family) fill into an existing
    // on-disk pricing.json without clobbering the user's edited values.
    for (const [k, v] of Object.entries(DEFAULT_PRICING)) if (!p.tiers[k]) p.tiers[k] = v;
    return p;
  }
  _writeAtomic(f, data) { const t = f + '.tmp'; fs.writeFileSync(t, data); fs.renameSync(t, f); }
  _shardFor(ts) { const d = new Date(ts); return path.join(this.dir, `events-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.ndjson`); }

  // Build claudeSessionId → {acct, mode, host, backend, name} from session-meta.
  // TTL-cached: data/ can live on network storage (real deployment: a FUSE NFS
  // mount where every readFileSync is a ~40ms round trip — 66 meta files took
  // 2.7s PER SCAN). Meta only affects labels/attribution of NEW events, so up
  // to 60s staleness is invisible.
  _metaMap() {
    if (this._metaMapCache && Date.now() - this._metaMapCache.at < 60000) return this._metaMapCache.map;
    const map = {};
    let files = [];
    try { files = fs.readdirSync(this.metaDir); } catch {}
    for (const fn of files) {
      if (!fn.endsWith('.json')) continue;
      let m; try { m = JSON.parse(fs.readFileSync(path.join(this.metaDir, fn), 'utf-8')); } catch { continue; }
      const sid = m.claudeSessionId || m.backendSessionId;
      if (!sid) continue;
      map[sid] = { acct: m.accountId || m._accountId || null, mode: m.mode || null, host: m.host || null, backend: m.backend || 'claude', name: m.name || null };
    }
    this._metaMapCache = { at: Date.now(), map };
    return map;
  }

  // Incrementally scan every transcript (Claude JSONLs + Codex rollouts),
  // appending new per-request events.
  // One-time repair of events baked with the old _acctAt fallback (which
  // attributed pre-binding history to the account's first attribution entry).
  // Only events whose sid HAS attribution entries are recomputed — for sids
  // without any, the baked value is the only record we have, leave it.
  _maybeRebakeAttribution() {
    const marker = path.join(this.dir, '.attrib-rebake-v1');
    try { if (fs.existsSync(marker)) return; } catch {}
    const attrib = this._attribMap();
    const meta = this._metaMap();
    let shards = [];
    try { shards = fs.readdirSync(this.dir).filter((f) => /^events-\d{4}-\d{2}\.ndjson$/.test(f)); } catch {}
    let changed = 0;
    for (const fn of shards) {
      const fp = path.join(this.dir, fn);
      let data = ''; try { data = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
      const out = [];
      let dirty = false;
      for (const line of data.split('\n')) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { out.push(line); continue; }
        if (e.sid && attrib[e.sid]) {
          const acct = this._acctAt(e.sid, e.ts, attrib, meta[e.sid]?.acct);
          // remote-host events (atype 'host') are attributed at ingest — the
          // LOCAL attribution log knows nothing about remote sids and would
          // silently re-bucket them to global here (2.127.0)
          if (e.atype !== 'host' && (acct || null) !== (e.acct || null)) {
            const ainfo = acct ? (this._resolveAccount(acct) || null) : null;
            e.acct = acct || null;
            e.atype = ainfo ? ainfo.type : (acct ? 'unknown' : 'global');
            e.aname = ainfo ? (ainfo.name || null) : null;
            dirty = true; changed++;
            out.push(JSON.stringify(e));
            continue;
          }
        }
        out.push(line);
      }
      if (dirty) this._writeAtomic(fp, out.join('\n') + '\n');
    }
    if (changed) this._evCache = null; // sizes may match — force a clean reload
    try { fs.writeFileSync(marker, JSON.stringify({ at: Date.now(), changed })); } catch {}
    if (changed) console.log(`[usage-history] re-attributed ${changed} events (pre-binding history → global)`);
  }

  scan(force = false) {
    if (this._scanning) return { skipped: true };
    try { this._maybeRebakeAttribution(); } catch (e) { console.error('[usage-history] rebake failed:', e.message); }
    // The Usage window fires a request per filter/range change — each used to
    // redo the full transcript stat-sweep (+ meta/attrib reload). Throttle:
    // new events land at most ~15s late; the 3-min background rescan and the
    // in-memory event cache (below) make requests read-only in the common case.
    if (!force && this._lastScanAt && Date.now() - this._lastScanAt < 15000) return { skipped: true };
    this._lastScanAt = Date.now();
    this._scanning = true;
    let added = 0, filesTouched = 0;
    try {
      const meta = this._metaMap();
      this._lastMetaMap = meta; // reused by aggregate() for session-name labels
      const attrib = this._attribMap();
      const shardBuffers = {}; // shardPath → [lines]
      const push = (ev) => {
        const shard = this._shardFor(ev.ts);
        (shardBuffers[shard] = shardBuffers[shard] || []).push(JSON.stringify(ev));
        added++;
      };
      // ── ONE WALK (2.297.0, the twin-killer): the local ledger walk IS
      // src/usage-walker.js — the SAME module the device daemon runs for
      // remote machines (`usage-scan` op) and the shipped scanner mirrors for
      // checkout-less ssh hosts. Local invokes it IN-PROCESS with its own
      // cursor store injected (CS principle 2: shared implementation, not
      // mandatory socket transit). Enrichment (attribution / meta / pool /
      // account type) happens HERE because only the orchestrator holds those
      // maps — the walker stays a pure per-machine fact collector. Rotation
      // reset, byte cursors, subagent/workflow coverage, codex rollouts and
      // the rid/mid join fields are all the walker's single implementation
      // now; scripts/test-usage-walk-parity.mjs pins it against the shipped
      // scanner (the one remaining, documented copy).
      const walk = runUsageWalk({
        projectsDir: this.projectsDir,
        codexSessionsDir: this.codexSessionsDir,
        cursors: this._cursors,
        onEvent: (ev) => {
          const minfo = meta[ev.sid] || {};
          // OBSERVED truth wins over link-intent (2.361.0, B-345b): the OTel
          // api_request stream names the org that actually billed this rid —
          // during hot-switch stale-token windows the attribution walk is
          // wrong for up to a token lifetime. undefined = no truth → walk.
          const tr = this._truthLookup ? this._truthLookup(ev.rid) : undefined;
          const acct = tr !== undefined ? tr : this._acctAt(ev.sid, ev.ts, attrib, minfo.acct);
          const pool = this._poolAt(ev.sid, ev.ts, attrib);
          const ainfo = acct ? (this._resolveAccount(acct) || null) : null;
          push({
            rid: ev.rid,
            mid: ev.mid, // message.id join field (2.267.3, the est-2× incident)
            ts: ev.ts, sid: ev.sid,
            be: ev.be === 'codex' ? 'codex' : (minfo.backend || 'claude'),
            model: ev.model,
            effort: ev.effort, // codex reasoning effort (turn_context) — claude events carry none (undefined = not serialized)
            acct: acct || null,
            pool: pool || undefined, // billed THROUGH this pool (acct = its real target)
            atype: ainfo ? ainfo.type : (acct ? 'unknown' : 'global'),
            aname: ainfo ? (ainfo.name || null) : null,
            mode: minfo.mode || null,
            host: minfo.host || null,
            cwd: ev.cwd,
            i: ev.i, cw5: ev.cw5, cw1: ev.cw1, cr: ev.cr, o: ev.o,
            tier: ev.tier,
          });
        },
      });
      filesTouched = walk.filesTouched;
      this._cursors = walk.cursors;

      for (const [shard, lines] of Object.entries(shardBuffers)) {
        if (lines.length) { fs.appendFileSync(shard, lines.join('\n') + '\n'); if (this._evCache) this._evCache.checkedAt = 0; } // our own append ⇒ next _loadEvents re-checks (2.369.36 throttle)
      }
      this._writeAtomic(this.cursorsFile, JSON.stringify(this._cursors));
      this._lastScan = Date.now();
    } finally { this._scanning = false; }
    return { added, filesTouched };
  }

  /** Remote-host events (2.127.0): ingest the NDJSON a host-side
   *  vibespace-usage-scan run returned. Attribution is baked per host
   *  (acct 'host-<id>', atype 'host') so remote usage NEVER mixes with local
   *  accounts; rid is namespaced per host and the read-time Set dedup absorbs
   *  re-emitted events (remote cursor loss / interrupted transfer). Appends to
   *  the SAME monthly shards, so aggregation/window filters just work. */
  ingestRemoteEvents(hostId, hostName, text) {
    let added = 0;
    const shardBuffers = {};
    for (const line of String(text || '').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!e || !e.rid || !e.ts) continue;
      const ts = Number(e.ts) || Date.now();
      // ── PER-ACCOUNT attribution for remote events (2.294.0, R4 deliverable;
      // the owner's live complaint: a remote message's billing row could only
      // say "<host>'s machine login"). VibeSpace ALREADY knows which account
      // it spawned a remote session with — writeSessionMeta records it into
      // attribution.ndjson exactly like a local one — and the walker carries
      // the session id, so the by-time walk resolves the real account.
      // FALLBACK STAYS HONEST: a session VibeSpace did not spawn (an external
      // terminal on that machine, or one predating attribution) has no entry,
      // and those keep the host bucket rather than being invented into some
      // account. atype 'host' therefore now means "billed by that machine's
      // own login", which is what it always claimed. ──
      const attrib = this._attribMap();
      const resolved = e.sid ? this._acctAt(e.sid, ts, attrib, null) : null;
      const rinfo = resolved ? (this._resolveAccount(resolved) || null) : null;
      const rpool = e.sid ? this._poolAt(e.sid, ts, attrib) : null;
      const ev = {
        rid: `h:${hostId}:${e.rid}`,
        // JOIN-FIELD completeness (adversarial review): when the host
        // transcript record had no requestId the walker's rid FELL BACK to
        // msg.id and omitted mid — the namespaced 'h:<host>:msg_X' then
        // matched neither of _liveDelta's id sets, so that request counted
        // TWICE in the live odometer forever (the ring has no age-out).
        mid: e.mid || (/^msg_/.test(String(e.rid || '')) ? e.rid : undefined),
        ts,
        sid: e.sid || null,
        be: e.be === 'codex' ? 'codex' : 'claude', // v2 walkers emit codex rollout events too
        model: e.model || null,
        effort: e.effort || undefined, // codex per-turn effort (walker v3) — absent for claude
        acct: resolved || hostId, // host ids are already 'host-…' — distinct from acct-/sub-/cxs- account ids
        pool: rpool || undefined,
        atype: resolved ? (rinfo ? rinfo.type : 'unknown') : 'host',
        aname: resolved ? (rinfo ? (rinfo.name || null) : null) : (hostName || hostId),
        mode: null,
        host: hostId,
        cwd: e.cwd || null,
        i: e.i || 0, cw5: e.cw5 || 0, cw1: e.cw1 || 0, cr: e.cr || 0, o: e.o || 0,
        tier: e.tier || null,
      };
      const shard = this._shardFor(ev.ts);
      (shardBuffers[shard] = shardBuffers[shard] || []).push(JSON.stringify(ev));
      added++;
    }
    for (const [shard, lines] of Object.entries(shardBuffers)) {
      if (lines.length) { fs.appendFileSync(shard, lines.join('\n') + '\n'); if (this._evCache) this._evCache.checkedAt = 0; } // our own append ⇒ next _loadEvents re-checks (2.369.36 throttle)
    }
    return { added };
  }

  // Feed a file's UNSCANNED bytes to onLine, in bounded chunks — a rollout can
  // exceed Node's max string length (real case: 1.9GB), so the file must never
  // be materialized whole. Only complete lines are consumed; a partial tail
  // waits for the next scan. CRITICAL (do not regress): cur.offset is a BYTE
  // position — advance by Buffer.byteLength of the consumed text, never by the
  // UTF-16 string length (CJK under-advances → records re-counted, totals
  // inflate). A chunk may end mid-UTF-8-sequence; everything up to the last
  // newline still decodes cleanly (continuation bytes can't be '\n'), and the
  // partial char is re-read from the byte-accurate offset next iteration.

  _tier(model) {
    // Data-driven: longest tier key that substring-matches the model id wins
    // ('gpt-5.6-sol' beats 'gpt-5.6…' prefixes; adding a tier in pricing.json
    // makes it match with no code change).
    const m = String(model || '').toLowerCase();
    if (!this._tierKeys || this._tierKeysFor !== this._pricing.tiers) {
      this._tierKeys = Object.keys(this._pricing.tiers).filter(k => k !== '_default').sort((a, b) => b.length - a.length);
      this._tierKeysFor = this._pricing.tiers;
      this._tierMemo = new Map(); // per-model result — substring matching per event was the aggregate hot spot
    }
    const hit = this._tierMemo.get(m);
    if (hit !== undefined) return hit;
    let out = '_default';
    for (const k of this._tierKeys) if (m.includes(k)) { out = k; break; }
    this._tierMemo.set(m, out);
    return out;
  }
  // The rate for a given account + tier: an account may override specific tiers
  // and/or carry a flat discount (0..1). Subscriptions/global have no override →
  // default tiers (the API-equivalent reference).
  _rateFor(acct, tier) {
    const ov = acct ? this._pricing.accounts?.[acct] : null;
    const base = (ov?.tiers && ov.tiers[tier]) || this._pricing.tiers[tier] || this._pricing.tiers._default;
    const disc = ov && typeof ov.discount === 'number' ? Math.max(0, Math.min(0.99, ov.discount)) : 0;
    if (!disc) return base;
    const f = 1 - disc;
    return { input: base.input * f, output: base.output * f, cacheWrite5m: base.cacheWrite5m * f, cacheWrite1h: base.cacheWrite1h * f, cacheRead: base.cacheRead * f };
  }
  _cost(ev) {
    const p = this._rateFor(ev.acct, this._tier(ev.model));
    return (ev.i * p.input + ev.o * p.output + ev.cw5 * p.cacheWrite5m + ev.cw1 * p.cacheWrite1h + ev.cr * p.cacheRead) / 1e6;
  }
  /** Stable token for the EFFECTIVE price table (tiers + per-account overrides
   *  and discounts) — the VERSION half of any memo key over computed costs.
   *  A pricing edit changes every historical cost while the ledger is
   *  untouched, so a cost memo keyed only by ids+interval+event-count served
   *  pre-edit dollars forever (2.369.43; the anchors' interval memo is the one
   *  consumer). Recomputed only when `_pricing` is REPLACED — setPricing builds
   *  a NEW object, the same identity check `_tier` uses for its tier keys. */
  pricingToken() {
    if (this._priceTok && this._priceTokFor === this._pricing) return this._priceTok;
    let tok;
    try {
      tok = crypto.createHash('sha1').update(JSON.stringify([this._pricing?.tiers || null, this._pricing?.accounts || null])).digest('hex').slice(0, 12);
    } catch {
      tok = 'nohash-' + Date.now(); // unhashable table ⇒ a fresh token: never reuse another table's costs
    }
    this._priceTokFor = this._pricing;
    this._priceTok = tok;
    return tok;
  }

  // In-memory event cache — the "database" behind aggregate(). Shards are
  // append-only NDJSON, so after the first full load each call reads ONLY the
  // appended bytes of each shard (byte-offset per file, last-newline aligned —
  // BYTES not chars, same CJK lesson as the scan cursors). Dedup by rid happens
  // once at load time (the ledger can contain a duplicate rid if a crash hit
  // between a shard append and the cursor write). Without this, every Usage
  // window request re-read + re-parsed every shard (~seconds at 100k+ events).
  _loadEvents() {
    if (!this._evCache) this._evCache = { consumed: new Map(), events: [], rids: new Set(), mids: new Set(), srcWm: new Map(), checkedAt: 0 };
    const c = this._evCache;
    // inc-mtox23xw (2.369.36): this ran a readdir + a stat per shard on EVERY
    // call — and the estimator calls it once per anchor PAIR (thousands per
    // learn) → ~90 openat/s on the main thread. The ledger only grows through
    // scan() (which drops the cache), so a 1s re-check throttle loses nothing.
    if (Date.now() - (c.checkedAt || 0) < 1000) return c.events;
    c.checkedAt = Date.now();
    let files = [];
    try { files = fs.readdirSync(this.dir).filter(f => /^events-\d{4}-\d{2}\.ndjson$/.test(f)).sort(); } catch {}
    for (const fn of files) {
      const fp = path.join(this.dir, fn);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      const consumed = c.consumed.get(fn) || 0;
      if (st.size === consumed) continue;
      if (st.size < consumed) { // shard shrank (manual edit/rotation) — rebuild from scratch
        this._evCache = null;
        return this._loadEvents();
      }
      let buf;
      const fd = fs.openSync(fp, 'r');
      try {
        buf = Buffer.alloc(st.size - consumed);
        fs.readSync(fd, buf, 0, buf.length, consumed);
      } finally { fs.closeSync(fd); }
      const lastNl = buf.lastIndexOf(10); // complete lines only — a concurrent append may be mid-write
      if (lastNl < 0) continue;
      for (const line of buf.slice(0, lastNl + 1).toString('utf-8').split('\n')) {
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.rid) { if (c.rids.has(ev.rid)) continue; c.rids.add(ev.rid); }
        if (ev.mid) c.mids.add(ev.mid); // stream-side id space (live-odometer exclusion join)
        // per-SOURCE watermark (offline-bias defense, 2.297.0): the newest
        // event timestamp we hold from each machine — 'local' for this one.
        // Free here (rides the incremental append walk); consumers ask
        // sourceWatermarks() to detect an ACTIVE source that has gone dark.
        const src = ev.host || 'local';
        if ((ev.ts || 0) > (c.srcWm.get(src) || 0)) c.srcWm.set(src, ev.ts);
        c.events.push(ev);
      }
      c.consumed.set(fn, consumed + lastNl + 1);
    }
    return c.events;
  }

  // Pre-load the event cache (called once at boot so the first Usage window
  // open doesn't pay the full-ledger parse).
  warm() { try { this._loadEvents(); } catch {} }

  /** Per-source (per-machine) newest-event-timestamp map: {local: ts, <hostId>: ts}.
   *  The offline-bias defense reads this to tell "idle" from "dark": a source
   *  with RECENT events whose link is down is actively-consuming-but-invisible
   *  — the dangerous underestimate direction. */
  sourceWatermarks() {
    try { this._loadEvents(); } catch {}
    const out = {};
    for (const [k, v] of (this._evCache?.srcWm || new Map())) out[k] = v;
    return out;
  }

  // Which ledger event carries this requestId — the per-message meta popup's
  // "which account handled this?" (2.266.1, user request). Backwards search:
  // the asked-about message is almost always recent.
  eventForRid(rid) {
    if (!rid) return null;
    try { this.scan(); } catch { } // throttled incremental — freshens just-streamed messages
    const evs = this._loadEvents();
    for (let i = evs.length - 1; i >= 0; i--) if (evs[i].rid === rid) return evs[i];
    // REMOTE sessions (real report: every reply on a remote conversation
    // showed "not in the ledger yet"): the host harvest namespaces its rids
    // `h:<hostId>:<rid>`, so an exact match on the plain request id can never
    // find them. Suffix-match the namespaced form before giving up.
    const suf = ':' + rid;
    for (let i = evs.length - 1; i >= 0; i--) {
      const r = evs[i].rid;
      if (typeof r === 'string' && r.startsWith('h:') && r.endsWith(suf)) return evs[i];
    }
    return null;
  }

  /** Join by message.id — the id BOTH transports carry (the 2.267.3 rule).
   *  Live stdout records have NO requestId, so the popup's per-message
   *  billing lookup joins here: ev.mid (baked since 2.267.3), or ev.rid
   *  when the walker fell back to msg.id (records without requestId), or a
   *  host-namespaced rid ending in the mid. */
  eventForMid(mid) {
    if (!mid) return null;
    try { this.scan(); } catch { }
    const evs = this._loadEvents();
    const suf = ':' + mid;
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i];
      if (ev.mid === mid || ev.rid === mid) return ev;
      if (typeof ev.rid === 'string' && ev.rid.startsWith('h:') && ev.rid.endsWith(suf)) return ev;
    }
    return null;
  }

  /** Time-sorted view of the cache (rebuilt lazily when the event count
   *  changes — shards append in scan order, remote harvests interleave). */
  _sortedEvents() {
    const evs = this._loadEvents();
    const c = this._evCache;
    if (!c.sorted || c.sortedLen !== evs.length) { c.sorted = evs.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)); c.sortedLen = evs.length; }
    return c.sorted;
  }
  /** Number of cached events with ts <= t (binary search) — the memo VERSION
   *  for an interval ending at t: unchanged ⇒ no event can have entered it. */
  _evCountUpTo(t) {
    const arr = this._sortedEvents();
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if ((arr[mid].ts || 0) <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  // Yield UNIQUE events in [from,to] (epoch ms) from the in-memory cache.
  // O(log n + k) since 2.369.36 (inc-mtox23xw): the estimator walks this once
  // per anchor pair; a full-ledger scan per pair blocked the loop for 10-59s
  // (captured by Debugger.pause inside _events ← costBetweenMulti ← learnRates).
  * _events(from, to) {
    const arr = this._sortedEvents();
    let lo = 0;
    if (from) { let hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if ((arr[mid].ts || 0) < from) lo = mid + 1; else hi = mid; } }
    for (let i = lo; i < arr.length; i++) {
      const ev = arr[i];
      if (to && ev.ts > to) break;
      yield ev;
    }
  }

  _emptyBucket() { return { requests: 0, sessions: new Set(), input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, cost: 0 }; }
  _add(b, ev) {
    b.requests++; b.sessions.add(ev.sid);
    b.input += ev.i; b.cacheWrite5m += ev.cw5; b.cacheWrite1h += ev.cw1; b.cacheRead += ev.cr; b.output += ev.o;
    b.cost += this._cost(ev);
  }
  _finalize(b) {
    const totalIn = b.input + b.cacheWrite5m + b.cacheWrite1h + b.cacheRead;
    return {
      requests: b.requests, sessions: b.sessions.size,
      input: b.input, cacheWrite5m: b.cacheWrite5m, cacheWrite1h: b.cacheWrite1h,
      cacheWrite: b.cacheWrite5m + b.cacheWrite1h, cacheRead: b.cacheRead, output: b.output,
      totalInput: totalIn, totalTokens: totalIn + b.output,
      cacheHitRatio: totalIn ? b.cacheRead / totalIn : 0,
      cost: b.cost,
    };
  }

  // The one flexible query the UI uses. groupBy is an array of dimension keys;
  // returns { totals, series(byDay), groups: { <dim>: [{key,...}] }, accounts }.
  aggregate({ from = null, to = null, backend = null, accounts = null, hostFilter = null, pivots = null } = {}) {
    const dims = { day: {}, model: {}, account: {}, billing: {}, project: {}, mode: {}, host: {}, hour: {}, weekday: {}, session: {}, pool: {} };
    const dimMeta = {}; // dim → key → {name,type,...} extra labels
    // pivots = [[dimA, dimB], …] — 2-D crosses for the dashboard's split-series
    // panels (e.g. day×account = per-account daily token stacks). Cells carry
    // the same finalized bucket shape as group rows, so the client's metric
    // extraction works unchanged.
    const pivotPairs = (pivots || []).filter((p) => Array.isArray(p) && p.length === 2 && p[0] !== p[1] && p[0] in dims && p[1] in dims);
    const pivotAcc = pivotPairs.map(() => ({}));
    const totals = this._emptyBucket();
    let firstTs = null, lastTs = null;
    for (const ev of this._events(from, to)) {
      if (backend && ev.be !== backend) continue;
      // The two CLIs' machine logins are DIFFERENT identities — separate buckets
      // ('__global__' = claude, '__global_codex__' = codex), else the account
      // dimension/filter conflates them.
      const acctKey = ev.acct || (ev.be === 'codex' ? '__global_codex__' : '__global__');
      // accounts = Set of bucket keys (account ids / globals); the UI can pass
      // several at once (e.g. a named sub + its global when the machine login
      // IS that account) — the whole dashboard then shows one account.
      if (accounts && !accounts.has(acctKey)) continue;
      // Device dimension (2.128.0): 'local' = this machine, else a host id —
      // a TOP-LEVEL filter over the whole view (hosts are devices, not accounts)
      if (hostFilter && (ev.host || 'local') !== hostFilter) continue;
      this._add(totals, ev);
      if (firstTs == null || ev.ts < firstTs) firstTs = ev.ts;
      if (lastTs == null || ev.ts > lastTs) lastTs = ev.ts;
      const d = new Date(ev.ts);
      const keyOf = {
        day: d.toISOString().slice(0, 10),
        model: ev.model || 'unknown',
        account: acctKey,
        // billing = the coarse category, so subscription $ and API $ never merge
        billing: ev.atype === 'api' ? 'api-key' : ev.atype === 'subscription' ? 'subscription' : ev.atype === 'codex-subscription' ? 'chatgpt' : ev.atype === 'host' ? 'remote-host' : (ev.acct ? 'unknown-account' : (ev.be === 'codex' ? 'codex-cli-login' : 'cli-global-login')),
        project: ev.cwd || 'unknown',
        mode: ev.mode || 'unknown',
        host: ev.host || 'local',
        hour: String(d.getHours()),
        weekday: String(d.getDay()),
        session: ev.sid,
        pool: ev.pool || null, // only events billed THROUGH a pool have this
      };
      for (const dim of Object.keys(dims)) {
        const k = keyOf[dim];
        // pool is sparse — a null key would collect every non-pooled event into
        // one bucket = the whole account, defeating the point. Skip those.
        if (dim === 'pool' && !k) continue;
        (dims[dim][k] = dims[dim][k] || this._emptyBucket());
        this._add(dims[dim][k], ev);
      }
      for (let i = 0; i < pivotPairs.length; i++) {
        const ka = keyOf[pivotPairs[i][0]], kb = keyOf[pivotPairs[i][1]];
        // Same sparse-pool guard as the 1-D dim loop: a null pool key on EITHER
        // axis would collect every non-pooled event into a phantom "null"
        // series aggregating all non-pool spend (dashboard split-series/pivot
        // panels put pool on an axis) — review-caught, do not drop.
        if ((pivotPairs[i][0] === 'pool' && !ka) || (pivotPairs[i][1] === 'pool' && !kb)) continue;
        const row = (pivotAcc[i][ka] = pivotAcc[i][ka] || {});
        this._add(row[kb] = row[kb] || this._emptyBucket(), ev);
      }
      // Freeze human labels for the account dimension (name + billing type +
      // backend, so the UI can badge accounts/models with the vendor logo).
      if (!dimMeta.account) dimMeta.account = {};
      if (!dimMeta.account[acctKey]) {
        const live = ev.acct ? this._resolveAccount(ev.acct) : null;
        dimMeta.account[acctKey] = {
          name: ev.acct ? (live?.name || ev.aname || ev.acct) : (ev.be === 'codex' ? 'Codex CLI login' : 'Claude CLI login'),
          type: ev.atype || (ev.acct ? 'unknown' : 'global'),
          be: ev.be || 'claude',
          tail: live?.tail || null,
          deleted: ev.acct ? !live : false,
        };
      }
      // Device labels (2.128.0): the host dim's rows carry the host's display
      // name so the window's Device chips need no extra lookup
      if (!dimMeta.host) dimMeta.host = { local: { name: 'local' } };
      const hostKey = ev.host || 'local';
      if (!dimMeta.host[hostKey]) dimMeta.host[hostKey] = { name: ev.aname || hostKey };
      if (!dimMeta.model) dimMeta.model = {};
      if (!dimMeta.model[keyOf.model]) dimMeta.model[keyOf.model] = { be: ev.be || 'claude' };
      // Pool labels: the pseudo-account's display name (resolves even after the
      // pool re-points, since the pool id is stable).
      if (ev.pool) {
        if (!dimMeta.pool) dimMeta.pool = {};
        if (!dimMeta.pool[ev.pool]) {
          const pinfo = this._resolveAccount(ev.pool);
          dimMeta.pool[ev.pool] = { name: pinfo?.name || ev.pool, be: ev.be || 'claude', deleted: !pinfo };
        }
      }
      // Session names from session-meta (VibeSpace-created sessions carry one;
      // foreign sessions fall back to the id in the UI).
      if (!dimMeta.session) dimMeta.session = {};
      if (!dimMeta.session[ev.sid]) {
        const sm = this._lastMetaMap ? this._lastMetaMap[ev.sid] : null;
        dimMeta.session[ev.sid] = { name: sm?.name || null, be: ev.be || 'claude' };
      }
    }
    const groupOut = {};
    // Sequential dims keep AXIS order (day = lexicographic/chronological,
    // hour/weekday = numeric) — cost-sorting them scrambled the hour axis in
    // the dashboard (real report: bars ordered 18,21,2,16,… instead of 0→23).
    // Categorical dims stay cost-sorted (the client top-Ns them).
    const SEQ_SORT = {
      day: (a, b) => (a.key < b.key ? -1 : 1),
      hour: (a, b) => Number(a.key) - Number(b.key),
      weekday: (a, b) => Number(a.key) - Number(b.key),
    };
    for (const dim of Object.keys(dims)) {
      groupOut[dim] = Object.entries(dims[dim])
        .map(([key, b]) => ({ key, ...(dimMeta[dim]?.[key] || {}), ...this._finalize(b) }))
        .sort(SEQ_SORT[dim] || ((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens));
    }
    const series = groupOut.day.slice().sort((a, b) => a.key < b.key ? -1 : 1);
    const pivotOut = {};
    pivotPairs.forEach((pair, i) => {
      pivotOut[pair.join(':')] = Object.entries(pivotAcc[i])
        .map(([key, cells]) => ({
          key,
          cells: Object.fromEntries(Object.entries(cells).map(([k2, b]) => [k2, this._finalize(b)])),
        }))
        .sort((a, b) => (a.key < b.key ? -1 : 1)); // lexicographic; client re-orders seq dims
    });
    return {
      totals: this._finalize(totals),
      range: { from: firstTs, to: lastTs },
      pricing: this._pricing,
      series,
      groups: groupOut,
      ...(pivotPairs.length ? { pivots: pivotOut } : {}),
    };
  }

  // Attach human names to account/session groups (server enriches with account
  // names + session names it knows).
  pricingTable() { return this._pricing; }
  // Accept a full v2 object OR a partial patch ({tiers?, accounts?}). Merges so a
  // UI editor can PATCH just one account's discount without resending everything.
  setPricing(patch) {
    if (!patch || typeof patch !== 'object') return this._pricing;
    const cur = this._pricing;
    const next = { version: 2, tiers: { ...cur.tiers, ...(patch.tiers || {}) }, accounts: { ...cur.accounts } };
    if (patch.accounts) {
      for (const [id, cfg] of Object.entries(patch.accounts)) {
        if (cfg == null) delete next.accounts[id];       // null clears an override
        else next.accounts[id] = cfg;
      }
    }
    this._pricing = next;
    this._writeAtomic(this.pricingFile, JSON.stringify(next, null, 2));
    return next;
  }
}

module.exports = { UsageHistory, DEFAULT_PRICING };
