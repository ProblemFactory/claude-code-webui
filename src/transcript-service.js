'use strict';
/**
 * TranscriptService — ONE interface over the transcript parse stack
 * (R3 step 1 of docs/design-three-tier.md, pure refactor, server-hosted).
 *
 * Reading a conversation used to be a composite copy-pasted per endpoint:
 * refresh the remote cache (?host=) → warm the parse worker → prefer the live
 * session's normalizer (only once _historyLoaded) else rebuild from the
 * merged JSONL+buffer → answer page/turnmap/search/status/taskState; plus the
 * huge-file seek family (gapInfo/slab/full search/full turnmap) with its own
 * copy of the host-refresh dance. Three copies of the normalizer dance and
 * two of the host refresh lived in routes/sessions.js alone.
 *
 * THIS INTERFACE IS THE FUTURE DEVICE OP SCHEMA (`transcript.*`): when the
 * daemon hosts the same service next to the bytes, each method below becomes
 * an op and the orchestrator keeps calling the same shapes — locally
 * in-process (device #0, CS amendment #2), remotely over the mux. Keep
 * methods transport-neutral: refs in, plain serializable results out.
 *
 * ref = { backend, sessionId, cwd?, host? }
 */
const fs = require('fs');
const {
  findSessionJsonlPath, isSubagentMessage, warmSessionJsonlAsync,
} = require('./session-store');
const { createMessageManager } = require('./normalizers');
const {
  findCodexSessionJsonlPath, jsonlGapInfoAsync, readJsonlLineRangeAsync,
  scanJsonlUserTurnsAsync, searchJsonlFull, searchJsonlFullStream,
} = require('./adapters/codex');
const { get: harnessOf } = require('./harnesses'); // S3: store.locate per harness

const DEVICE_HANDLE = '\u0000device:'; // opaque to the route; never a real path
const isDeviceHandle = (fp) => typeof fp === 'string' && fp.startsWith(DEVICE_HANDLE);

function createTranscriptService({ activeSessions, createSessionMessages, hosts }) {
  // ── R3 SWITCHOVER (2.292.0): remote reads are served BY THE MACHINE THAT
  // HOLDS THE BYTES (the daemon's `transcript-op`, dark since 2.285.0 with a
  // byte-identical parity suite). The wire now carries parsed KBs instead of
  // multi-MB raw transcripts, which retires the whole partial-transfer
  // integrity class (2.187.0/2.188.1) for reads.
  // FALLBACK LADDER, per the design (never per-host, always per-op): device
  // op → the legacy fetch-to-data/remote-jsonl cache + local parse → honest
  // error. Capability-gated, so an un-upgraded daemon degrades silently.
  // LIVE SESSIONS DELIBERATELY SKIP THE DEVICE: the server owns the stdout
  // buffer overlay (the 2.74.0 position-preserving merge) and the live
  // normalizer, which the daemon-side service has no knowledge of — asking
  // the device there would drop the not-yet-flushed tail.
  let _devWarnedAt = 0;
  async function tryDevice(r, method, params) {
    if (!r.host || !hosts?.deviceBounded) return undefined;
    if (liveWithHistory(r)) return undefined; // server-owned overlay wins
    try {
      const dm = await hosts.deviceBounded(r.host, 6000);
      if (!dm?.transcriptOp) return undefined;
      if (!(await dm.connect?.())?.info?.capabilities?.includes?.('transcript-op')) return undefined;
      return await dm.transcriptOp(method, { backend: r.backend, sessionId: r.sessionId, cwd: r.cwd }, params || {});
    } catch (e) {
      // Degradation must be VISIBLE (the swallowed-degrade lesson): one log
      // per minute, then the legacy path runs — never a silent hang.
      if (Date.now() - _devWarnedAt > 60000) {
        _devWarnedAt = Date.now();
        console.warn(`[transcript] device read failed for ${r.host} (${method}) — falling back to the transcript cache:`, e.message);
      }
      return undefined;
    }
  }
  // Per-(host,session) throttle for the gap family: slabs hit this endpoint
  // once per scroll step, and old lines never change on an append-only file.
  const hostRefreshAt = new Map();
  const HOST_REFRESH_MS = 10000;

  const norm = (ref) => ({
    backend: ref.backend || 'claude',
    sessionId: ref.sessionId,
    cwd: ref.cwd || '',
    host: ref.host || null,
  });

  const liveSession = (r) => {
    for (const [, s] of activeSessions) {
      if ((s.backend || 'claude') !== r.backend) continue;
      if ((s.backendSessionId || s.claudeSessionId) === r.sessionId) return s;
    }
    return null;
  };

  /** A live session whose normalizer already holds the FULL history — the
   *  only case where the server's in-memory view beats re-reading the file
   *  (and the only case that carries the un-flushed stdout tail). */
  const liveWithHistory = (r) => {
    const s2 = liveSession(r);
    return !!(s2?._normalizer && s2._normalizer.total > 0 && s2._historyLoaded);
  };

  /** ?host= transcript cache refresh. throttled=true is the gap-family mode.
   *  Returns an error MESSAGE (never throws): "no transcript" and "the
   *  machine holding it was unreachable" must stay distinguishable. */
  async function refreshRemote(r, { throttled = false } = {}) {
    if (!r.host || !hosts) return null;
    if (throttled) {
      const key = `${r.host}:${r.sessionId}`;
      if (Date.now() - (hostRefreshAt.get(key) || 0) <= HOST_REFRESH_MS) return null;
      hostRefreshAt.set(key, Date.now());
      if (hostRefreshAt.size > 512) hostRefreshAt.delete(hostRefreshAt.keys().next().value);
    }
    try {
      await hosts.fetchTranscript(r.host, r.backend || 'claude', r.sessionId); // descriptor store.remoteFind picks the find(1) expression + cache name (S3)
      return null;
    } catch (e) { return e.message; }
  }

  function sessionShape(r, session) {
    return session || {
      backend: r.backend,
      backendSessionId: r.sessionId,
      claudeSessionId: r.backend === 'claude' ? r.sessionId : null,
      cwd: r.cwd,
      buffer: '',
    };
  }

  /** The normalizer dance, ONE home: prefer the live session's normalizer —
   *  but only once the WS attach loaded full history into it (_historyLoaded;
   *  after a restart processLive fills it with partial buffer data first, and
   *  serving that truncated history/search/turnmap to a handful of buffer
   *  messages) — else rebuild from the merged JSONL+buffer view. */
  async function view(ref) {
    const r = norm(ref);
    await refreshRemote(r);
    // through the harness descriptor (S3): claude = worker parse-cache warm,
    // codex = the 0.153 thread/read fallback for a MISSING rollout (B-21e4
    // item 5, local only); a harness without the hook skips
    try { const warm = harnessOf(r.backend || 'claude').store?.warmTranscript; if (warm) await warm(r.sessionId, r.cwd, { remote: !!r.host }); } catch { }
    const session = liveSession(r);
    // An attach rebuild in flight: join it instead of converting again
    // (review-caught: the HTTP side re-entered the exact sync stall the
    // ws attach path had just shed — a scroll-up during the rebuild window).
    if (session?._rebuildPromise) { try { await session._rebuildPromise; } catch { } }
    if (session?._normalizer && session._normalizer.total > 0 && session._historyLoaded) {
      return { mm: session._normalizer, session };
    }
    const sm = createSessionMessages(sessionShape(r, session));
    if (typeof sm.prepare === 'function') await sm.prepare(); // S9: a serve-backed reader (opencode stopped conversation) loads here — LOUD on failure, a user opened it
    const mm = createMessageManager(r.backend, 'api', { threadId: r.sessionId }); // the rendered conversation's id (codex ledger key)
    await mm.convertHistoryAsync(sm.raw());
    return { mm, session };
  }

  async function page(ref, { offset, limit, untilUuid } = {}) {
    const r0 = norm(ref);
    const viaDev = await tryDevice(r0, 'page', { offset, limit, untilUuid });
    if (viaDev) return viaDev;
    const { mm } = await view(ref);
    if (untilUuid) {
      const idx = mm.messages.findIndex((m) => m.uuid === untilUuid);
      const upto = idx >= 0 ? idx + 1 : mm.total;
      const start = Math.max(0, upto - 50);
      return { messages: mm.messages.slice(start, upto), total: upto };
    }
    if (offset !== undefined || limit !== undefined) {
      return { messages: mm.slice(parseInt(offset) || 0, parseInt(limit) || 50), total: mm.total };
    }
    return { messages: mm.tail(50), total: mm.total };
  }

  async function turnmap(ref) {
    const viaDev = await tryDevice(norm(ref), 'turnmap', {});
    if (viaDev) return viaDev;
    const { mm } = await view(ref);
    return { turns: mm.turnMap(), total: mm.total };
  }

  async function searchIndexed(ref, q) {
    const viaDev = await tryDevice(norm(ref), 'searchIndexed', { q });
    if (viaDev) return viaDev;
    const { mm } = await view(ref);
    return { matches: mm.search(q), total: mm.total };
  }

  /** chatStatus + taskState + turnMap composite (the withStatus attach shape).
   *  Permission mode isn't recoverable from the JSONL — the live session's
   *  spawn-time mode merges in when the transcript carries none. */
  async function status(ref) {
    const r = norm(ref);
    const session = liveSession(r);
    const viaDev = await tryDevice(r, 'status', {});
    if (viaDev) {
      // permissionMode is NOT in the transcript — it only exists in the live
      // session's spawn args, so the merge stays server-side either way
      if (session?._permissionMode && viaDev.chatStatus && !viaDev.chatStatus.permissionMode) viaDev.chatStatus.permissionMode = session._permissionMode;
      return viaDev;
    }
    const sm = createSessionMessages(sessionShape(r, session));
    if (typeof sm.prepare === 'function') await sm.prepare(); // S9: a serve-backed reader (opencode stopped conversation) loads here — LOUD on failure, a user opened it
    const chatStatus = sm.chatStatus();
    if (session?._permissionMode && chatStatus && !chatStatus.permissionMode) {
      chatStatus.permissionMode = session._permissionMode;
    }
    return { chatStatus, taskState: sm.taskState?.() || null };
  }

  async function taskState(ref) {
    const r = norm(ref);
    const viaDev = await tryDevice(r, 'taskState', {});
    if (viaDev) return viaDev;
    await refreshRemote(r);
    const sm = createSessionMessages(sessionShape(r, liveSession(r)));
    if (typeof sm.prepare === 'function') await sm.prepare(); // S9: a serve-backed reader (opencode stopped conversation) loads here — LOUD on failure, a user opened it
    return sm.taskState() || {};
  }

  // S3: the harness descriptor's store.locate owns "where does this
  // conversation live" — no backend ternary here (unknown ids throw in get()).
  function localTranscriptPath(r) {
    const h = harnessOf(r.backend || 'claude');
    if (!h.store || typeof h.store.locate !== 'function') return null;
    return h.store.locate(r.sessionId, r.cwd) || null;
  }
  function filePath(ref) {
    const r = norm(ref);
    return localTranscriptPath(r);
  }

  /** Huge-file seek family — switched to the device AS ONE UNIT (2.293.0,
   *  once the daemon gained a searchFull op). This family speaks in FILE LINE
   *  NUMBERS: serving gapInfo/slabs from the device while search read a local
   *  cache copy would put line offsets on TWO sources of truth and teleport
   *  the reader to the wrong place. So gapInfo returns an opaque HANDLE
   *  instead of a bare path — `device:<host>` when the device serves, else
   *  the local file path — and every follow-up (slab / search / turnmap)
   *  honours it. The route treats the handle as opaque (it only checks
   *  truthiness and passes it back), so the whole family switches atomically
   *  or not at all. Streaming search over the device degrades to ONE batch
   *  (no streaming op yet): matches still arrive as NDJSON, just together. */
  async function gapInfo(ref) {
    const r = norm(ref);
    const viaDev = await tryDevice(r, 'gapInfo', {});
    if (viaDev && viaDev.hasFile) return { gap: viaDev.gap, fp: DEVICE_HANDLE + r.host, hostFetchError: null };
    if (viaDev && viaDev.hasFile === false) return { gap: null, fp: null, hostFetchError: null };
    const hostFetchError = await refreshRemote(r, { throttled: true });
    const fp = filePath(ref);
    if (!fp || !fs.existsSync(fp)) return { gap: null, fp: null, hostFetchError };
    let gap = null;
    try { gap = await jsonlGapInfoAsync(fp); } catch { }
    return { gap, fp, hostFetchError };
  }

  /** Normalize one raw line-range slab (subagent records dropped to match the
   *  display path; orphan tool calls acceptable for read-only browsing). */
  async function gapSlab(ref, fp, fromLine, toLine) {
    if (isDeviceHandle(fp)) {
      const r0 = norm(ref);
      const viaDev = await tryDevice(r0, 'gapSlab', { fromLine, toLine });
      if (viaDev) return viaDev.messages || [];
      return []; // handle said device; a mid-family fallback would mix line spaces
    }
    let records = [];
    try { records = await readJsonlLineRangeAsync(fp, fromLine, toLine); } catch { }
    records = records.filter((rec) => !isSubagentMessage(rec));
    const r = norm(ref);
    const mm = createMessageManager(r.backend, 'gap', { threadId: r.sessionId }); // a slab carries no session_meta — only the reader knows the file
    mm.convertHistory(records);
    return mm.tail(mm.total);
  }

  async function searchFull(ref, fp, q) {
    if (isDeviceHandle(fp)) return (await tryDevice(norm(ref), 'searchFull', { q })) || { matches: [], truncated: false };
    return searchJsonlFull(fp, norm(ref).backend, q);
  }
  /** Device mode has no streaming op yet: run the device's one-shot search and
   *  replay its matches through onMatch, so the NDJSON contract is unchanged
   *  (results arrive together instead of trickling — honest degradation, and
   *  the wire carries matches, not the whole transcript). */
  async function searchFullStream(ref, fp, q, onMatch, opts) {
    if (isDeviceHandle(fp)) {
      const res = (await tryDevice(norm(ref), 'searchFull', { q })) || { matches: [], truncated: false };
      for (const m of (res.matches || [])) { if (opts?.signal?.aborted) break; onMatch(m); }
      return { total: (res.matches || []).length, truncated: !!res.truncated };
    }
    return searchJsonlFullStream(fp, norm(ref).backend, q, onMatch, opts);
  }
  async function fullTurnmap(ref, fp) {
    if (isDeviceHandle(fp)) {
      const viaDev = await tryDevice(norm(ref), 'fullTurnmap', {});
      return viaDev?.turns || [];
    }
    return scanJsonlUserTurnsAsync(fp, norm(ref).backend);
  }

  /** RESCUE (2.360.0, owner request after the 79928a2b 38MB poisoning): a
   *  transcript carrying MONSTER records (oversized single lines — shredded
   *  image pastes) kills resume (context overflow) AND blanks the history
   *  view (the tail window lands mid-line). Salvage = every oversized
   *  record's message content replaced IN PLACE by a short stub — same
   *  uuid/parent, so the chain, order and record count are untouched.
   *  Byte-preserved backup first; only rewritten lines are re-validated
   *  (untouched lines pass through byte-identical); atomic swap. Streamed —
   *  never blocks the loop on a multi-hundred-MB file. LOCAL only; refuses
   *  while any process still writes the file (the two-writer law). */
  async function rescue(ref, { maxLineBytes = 1024 * 1024 } = {}) {
    const r = norm(ref);
    if (r.hostId || r.host) throw new Error('rescue is local-only for now — copy the transcript here or run it on that machine');
    const fp = localTranscriptPath(r);
    if (!fp || isDeviceHandle(fp) || !fs.existsSync(fp)) throw new Error('transcript not found on this machine');
    try {
      require('child_process').execFileSync('fuser', [fp], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      throw new Error('a process is still writing this transcript — terminate the session first, then rescue');
    } catch (e) { if (/still writing/.test(e.message)) throw e; /* fuser exits 1 when nobody holds it */ }
    const sizeBefore = fs.statSync(fp).size;
    const backup = fp + '.pre-rescue-' + Date.now();
    fs.copyFileSync(fp, backup);
    const tmp = fp + '.rescue-tmp';
    const readline = require('readline');
    const rl = readline.createInterface({ input: fs.createReadStream(fp), crlfDelay: Infinity });
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    let lines = 0, replaced = 0, skipped = 0;
    for await (const line of rl) {
      lines++;
      if (line.length <= maxLineBytes) { if (!out.write(line + '\n')) await new Promise((res) => out.once('drain', res)); continue; }
      let stubbed = null;
      try {
        const d = JSON.parse(line);
        if (d && d.message && d.message.content !== undefined) {
          d.message.content = [{ type: 'text', text: `[rescued ${new Date().toISOString().slice(0, 10)}: an oversized ${Math.round(line.length / 1048576)}MB record was removed from this message — it broke resume and the history view. Full original preserved next to the transcript as ${backup.split('/').pop()}]` }];
          stubbed = JSON.stringify(d);
          JSON.parse(stubbed); // the ONLY rewritten bytes — must be valid
        }
      } catch { /* unparseable monster — drop below */ }
      if (stubbed) { replaced++; if (!out.write(stubbed + '\n')) await new Promise((res) => out.once('drain', res)); }
      else { skipped++; } // oversized AND unparseable/shape-unknown: dropping is safer than keeping poison
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    if (!replaced && !skipped) { try { fs.unlinkSync(tmp); fs.unlinkSync(backup); } catch { } return { replaced: 0, skipped: 0, lines, sizeBefore, sizeAfter: sizeBefore, backup: null }; }
    fs.renameSync(tmp, fp);
    try { fs.chmodSync(fp, 0o600); } catch { }
    return { replaced, skipped, lines, sizeBefore, sizeAfter: fs.statSync(fp).size, backup };
  }

  return { view, page, turnmap, searchIndexed, status, taskState, filePath, gapInfo, gapSlab, searchFull, searchFullStream, fullTurnmap, refreshRemote, rescue };
}

module.exports = { createTranscriptService };
