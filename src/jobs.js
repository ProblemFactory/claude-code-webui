// JobManager — Background Work engine (ORCH tier; docs/design-background-work.md M1).
// Registry + supervisor for agent-registered services / long tasks / cron.
// Laws honored here: single-engine lock; adopt-first boot; identity =
// pid+starttime+bootId re-verified at every act; intent-before-spawn; kill by
// handle only; age-based GC that never touches live work; atomic store +
// broadcast on change; async sweeps only; §ban-safety guardrails live in the
// PURE model (vetSpec/schedule floors) and in the sanitized job env here.
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const M = require('./job-model.js');

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp-' + process.pid;
  // _-prefixed keys are runtime-only (raw tokens, cursors) — never persisted
  fs.writeFileSync(tmp, JSON.stringify(obj, (k, v) => (k.startsWith('_') ? undefined : v), 1));
  fs.renameSync(tmp, file);
}
function readStarttime(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[19]);
  } catch { return 0; }
}
function bootId() { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim(); } catch { return ''; } }
// mirror of ws-handler's agentEnv drops (jobs must never inherit ambient vendor
// credentials or server config — §ban-safety structural leg)
function jobEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(VIBESPACE_|npm_|CLAUDE_CODE_)/.test(k)) delete env[k];
    if (['PORT', 'HOST', 'NODE_ENV', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'].includes(k)) delete env[k];
  }
  return { ...env, ...extra };
}
const now = () => Date.now();
const rid = () => 'jb-' + crypto.randomBytes(4).toString('hex');

class JobManager {
  /** deps: { dataDir, broadcast(type,payload), notifyUser({text,urgency,jobId}), log,
   *          deliverToConversation?(cid,text)→Promise<{ok,peerName?,reason?}>,   // 2.344.0 peer-message lane
   *          groupNotifyFor?(job)→true|false|null, notifyGlobal?()→bool }        // toggle resolution */
  constructor(deps) {
    this.d = deps;
    this.file = path.join(deps.dataDir, 'jobs.json');
    this.notifsFile = path.join(deps.dataDir, 'job-notifications.json');
    this.logsDir = path.join(deps.dataDir, 'job-logs');
    this.lockFile = path.join(deps.dataDir, 'jobs.lock');
    this.jobs = new Map();
    this.readOnly = false;
    this.ready = false;
    this.events = [];            // ring of {ts, jobId, name, what, verb} for injection
    this.pendingNotifs = new Map(); // conversationId → [{jobId, jobName, text, ts, urgency}] — OFFLINE stash, drained at resume injection
    this.waiters = new Map();    // jobId → [{resolve, timer}] (poll --wait)
    this.ansWaiters = new Map(); // jobId → [{resolve, timer}]
    this._timers = [];
    this._dirty = false;
    this._notifyRate = new Map(); // conversationId → {ts, text} — engine-side floor under the CLI's own throttles
  }

  // ── lifecycle ───────────────────────────────────────────────────────────
  init() {
    try {
      fs.mkdirSync(this.logsDir, { recursive: true });
      if (!this._takeLock()) {
        this.readOnly = true;
        this.d.log('[jobs] another engine holds the lock — READ-ONLY registry (no adopt/replay/cron)');
        this._load(); this._loadNotifs(); this.ready = true; return;
      }
      this._load();
      this._loadNotifs();
      this._adoptAndReplay();
      const t1 = setInterval(() => this._sweep().catch((e) => this.d.log('[jobs] sweep failed:', e.message)), 5000);
      const t2 = setInterval(() => this._cronTick().catch((e) => this.d.log('[jobs] cron tick failed:', e.message)), 30_000);
      const t3 = setInterval(() => this._gc().catch((e) => this.d.log('[jobs] gc failed:', e.message)), 3600_000);
      const t4 = setInterval(() => { if (this._dirty) this._save(); }, 2000);
      for (const t of [t1, t2, t3, t4]) { t.unref?.(); this._timers.push(t); }
      this._cronTick().catch(() => { });
      this.ready = true;
    } catch (e) {
      // engine failure must be LOUD but never block the server (§5 failure isolation)
      this.initError = e.message;
      this.d.log('[jobs] ENGINE INIT FAILED (subsystem down until next boot):', e.message);
      try { this.d.notifyUser({ text: `Background Work engine failed to start: ${e.message}`, urgency: 'high' }); } catch { }
    }
  }
  shutdown() { try { if (this._dirty) this._save(); } catch { } try { if (!this.readOnly) fs.unlinkSync(this.lockFile); } catch { } }

  _takeLock() {
    try {
      const cur = JSON.parse(fs.readFileSync(this.lockFile, 'utf-8'));
      if (cur.pid && readStarttime(cur.pid) === cur.starttime && cur.starttime) return cur.pid === process.pid; // live foreign engine
    } catch { }
    writeJsonAtomic(this.lockFile, { pid: process.pid, starttime: readStarttime(process.pid), at: now() });
    return true;
  }
  _load() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      for (const j of arr) this.jobs.set(j.id, j);
    } catch (e) {
      if (fs.existsSync(this.file)) { // corrupt store: preserve bytes, reconcile skeletons from log dirs (§5)
        const bad = this.file + '.corrupt-' + now();
        try { fs.renameSync(this.file, bad); } catch { }
        this.d.log('[jobs] store corrupt → preserved at', bad, '— rebuilding skeletons; error:', e.message);
        try {
          for (const id of fs.readdirSync(this.logsDir)) {
            if (!id.startsWith('jb-')) continue;
            this.jobs.set(id, { id, kind: 'task', name: id, state: 'unverified', note: 'recovered from corrupt store — resolve before reuse', owner: {}, access: { view: 'all', control: 'session' }, runs: [] });
          }
        } catch { }
        try { this.d.notifyUser({ text: 'Background Work store was corrupt — records recovered as unverified; resolve them in the Jobs panel', urgency: 'high' }); } catch { }
      }
    }
  }
  _save() {
    // a READ-ONLY engine (second server against a live lock) must never flush
    // its stale in-memory copy over the live engine's store (2.344.1 review
    // catch: shutdown()'s dirty-flush had no guard, and drainNotifs marks
    // dirty even in read-only mode)
    if (this.readOnly) { this._dirty = false; return; }
    try {
      writeJsonAtomic(this.file, [...this.jobs.values()]);
      writeJsonAtomic(this.notifsFile, Object.fromEntries(this.pendingNotifs));
      this._dirty = false;
    } catch (e) { this.d.log('[jobs] save failed:', e.message); }
  }
  _loadNotifs() {
    try {
      const obj = JSON.parse(fs.readFileSync(this.notifsFile, 'utf-8'));
      for (const [cid, list] of Object.entries(obj)) if (Array.isArray(list) && list.length) this.pendingNotifs.set(cid, list);
    } catch { }
  }

  // ── owner auto-notify (2.344.0, B-0bf4 — the CLI's own cross-session
  // messaging inbox is the delivery channel; docs/design-background-work
  // §Owner notify). VibeSpace never fabricates user input: a live owner
  // conversation gets a PEER MESSAGE on its inbox socket (the CLI queues it
  // mid-turn / opens a turn when idle, gated by its own inbound controls); an
  // absent owner gets a durable STASH entry injected passively at the next
  // SessionStart/prompt hook. Toggles: job override > group tri-state >
  // global agents.jobNotify (default ON).
  _notifyOwner(job, ev) {
    try {
      const cid = job.owner && job.owner.conversation && job.owner.conversation.id;
      // SUBSCRIBERS (2.345.0, owner request): sessions that explicitly opted
      // in to a visible job's events get the same message. A subscription is
      // its own explicit switch — group/global defaults and the owner's
      // --notify override govern the OWNER lane only; a subscriber leaves by
      // unsubscribing. View access was checked at subscribe time.
      // a cron CHILD inherits its parent's subscribers too — subscribing to
      // the visible cron record is the natural action, and the per-fire
      // events live on the child. Per-subscriber regex FILTERS (2.347.0)
      // match against the final notification text — a news watcher's
      // subscriber can ask for only /SpaceX/ lines; non-matching events are
      // simply not that subscriber's (no stash either).
      const parent = job.cronParent ? this.jobs.get(job.cronParent) : null;
      const notifText = M.renderOwnerNotify(job, ev);
      const seenSubs = new Set();
      for (const sub of [...(job.subscribers || []), ...((parent && parent.subscribers) || [])]) {
        if (!sub.conversationId || sub.conversationId === cid || seenSubs.has(sub.conversationId)) continue;
        seenSubs.add(sub.conversationId);
        if (!M.filterMatches(sub.filter, notifText)) continue;
        this._deliverTo(sub.conversationId, job, ev, { subscriber: true, text: notifText });
      }
      if (!cid) return; // user-created or lineage-less job — user lanes (inbox/panel) already cover it
      const eff = M.notifyEffective(job, this.d.groupNotifyFor ? this.d.groupNotifyFor(job) : null, this.d.notifyGlobal ? this.d.notifyGlobal() : true);
      if (!eff.on) { job.lastNotify = { ts: now(), lane: 'off', ok: false, source: eff.source }; this._notifyLogPush(job, { lane: 'off', ok: false, reason: 'auto-notify off (' + eff.source + ')' }); return; }
      this._deliverTo(cid, job, ev, {});
    } catch (e) { this.d.log('[jobs] owner notify failed:', e.message); }
  }
  /** one delivery attempt to ONE conversation (owner or subscriber): flood
   *  floor → socket post → stash fallback. Subscriber deliveries never stamp
   *  the job's lastNotify (that field narrates the OWNER lane). */
  _deliverTo(cid, job, ev, { subscriber, text: preText } = {}) {
    const text = preText || M.renderOwnerNotify(job, ev);
    // engine-side flood floor (the CLI also rate-limits + dedupes): ≥30s
    // between SOCKET posts per conversation, identical text 10min. A floored
    // DISTINCT event is STASHED, not dropped (2.344.1 review catch); only an
    // identical repeat is dropped outright.
    const rate = this._notifyRate.get(cid) || {};
    if (rate.text === text && rate.ts && now() - rate.ts < 600_000) {
      if (!subscriber) { job.lastNotify = { ts: now(), lane: 'suppressed', ok: false, reason: 'duplicate within 10min' }; this._notifyLogPush(job, { lane: 'suppressed', ok: false, reason: 'duplicate within 10min' }); }
      return;
    }
    if (rate.ts && now() - rate.ts < 30_000) {
      this._stashNotif(cid, job, ev, 'rate floor — queued for injection instead', { stampLast: !subscriber });
      this._dirty = true;
      return;
    }
    this._notifyRate.set(cid, { ts: now(), text });
    if (this._notifyRate.size > 500) { // prune: keep the map bounded
      const cut = now() - 600_000;
      for (const [k, v] of this._notifyRate) if (!v.ts || v.ts < cut) this._notifyRate.delete(k);
      if (this._notifyRate.size > 500) this._notifyRate.clear();
    }
    // kind:'notification' TYPES THE FRAME (2026-09-07, owner: 系统通知默认应该是
    // steering的): nobody is waiting for a reply here, so on a harness whose
    // notification lane is 'steer' (backend-caps notificationDelivery) this
    // joins the RUNNING turn instead of becoming its own billed turn after it.
    // The ENGINE does not decide the lane — the receiving wrapper does, because
    // only it knows whether a turn is running. The 30s floor + stash below stay
    // exactly as they were: a floored batch is drained as ONE injected block by
    // agent-routes (renderNotifStash), never re-delivered per entry.
    const deliver = this.d.deliverToConversation
      ? this.d.deliverToConversation(cid, text, { fromName: 'Background Work · ' + (job.name || job.id), kind: 'notification' })
      : Promise.resolve({ ok: false, reason: 'no delivery lane wired' });
    Promise.resolve(deliver).then((r) => {
      if (r && r.ok) {
        if (!subscriber) job.lastNotify = { ts: now(), lane: r.lane || 'message', ok: true, to: r.peerName || null };
        this._notifyLogPush(job, { lane: r.lane || 'message', ok: true, to: r.peerName || null, ...(subscriber ? { sub: true } : {}) });
      } else {
        this._stashNotif(cid, job, ev, (r && r.reason) || 'unreachable', { stampLast: !subscriber });
      }
      this._dirty = true;
      try { this.d.broadcast('jobs-updated', { id: job.id }); } catch { }
    }).catch((e) => {
      this._stashNotif(cid, job, ev, e.message, { stampLast: !subscriber }); // degrade path logs verbatim inside
      this._dirty = true;
    });
  }
  /** bounded per-job delivery journal (2.361.5, owner ask: "投递细节我好监控")
   *  — one entry per delivery ATTEMPT outcome, any lane. Rides the registry
   *  record; the panel renders it under the Auto-notify row. */
  _notifyLogPush(job, e) {
    job.notifyLog = [...(job.notifyLog || []), { ts: now(), ...e }].slice(-12);
    this._dirty = true;
  }
  _stashNotif(cid, job, ev, reason, { stampLast = true } = {}) {
    const q = this.pendingNotifs.get(cid) || [];
    q.push({ jobId: job.id, jobName: job.name, text: (ev && ev.what) || job.state, ts: now(), urgency: job.state === 'failed' ? 'normal' : 'low' });
    if (q.length > 30) q.splice(0, q.length - 30); // per-conversation cap; oldest fall off
    this.pendingNotifs.set(cid, q);
    if (stampLast) job.lastNotify = { ts: now(), lane: 'stash', ok: true, reason: reason || null };
    this._notifyLogPush(job, { lane: 'stash', ok: false, reason: reason || 'not reachable', to: String(cid).slice(0, 8) });
    this.d.log(`[jobs] notify → stashed for ${cid} (${reason || 'not reachable'})`);
  }
  /** explicit per-conversation subscription to a VISIBLE job's notifications
   *  (2.345.0). View access is the route's responsibility; dedupe by
   *  conversation lineage; cap 10 per job. */
  subscribe(job, caller, { filter } = {}) {
    if (this.readOnly) return { error: 'registry is read-only in this process' };
    if (!caller.conversationId) return { error: 'this session has no conversation id yet — send one message first, then subscribe' };
    const vf = M.validateFilter(filter);
    if (!vf.ok) return { error: vf.error };
    job.subscribers = job.subscribers || [];
    const existing = job.subscribers.find((s) => s.conversationId === caller.conversationId);
    if (existing) { // re-subscribe = update the filter in place (agents tune their own filters)
      const changed = (existing.filter || null) !== vf.filter;
      existing.filter = vf.filter;
      this._touch(job); this._save();
      return { ok: true, already: !changed, updated: changed, filter: vf.filter, count: job.subscribers.length };
    }
    if (job.subscribers.length >= 10) return { error: 'subscriber cap (10) reached for this job' };
    job.subscribers.push({ conversationId: caller.conversationId, sessionId: caller.sessionId || null, ts: now(), filter: vf.filter });
    this._touch(job); this._save();
    return { ok: true, count: job.subscribers.length, filter: vf.filter };
  }
  unsubscribe(job, caller) {
    if (this.readOnly) return { error: 'registry is read-only in this process' };
    const before = (job.subscribers || []).length;
    job.subscribers = (job.subscribers || []).filter((s) => s.conversationId !== caller.conversationId);
    this._touch(job); this._save();
    return { ok: true, removed: before - job.subscribers.length, count: job.subscribers.length };
  }
  /** the JOB PROCESS (or its owner) announces a noteworthy moment — the
   *  success/failure vocabulary decoupled from exit codes (2.346.0, owner
   *  point: a news-page watcher exits 0 every run; what matters is whether it
   *  FOUND something). Explicit call ⇒ event ring + owner/subscriber message,
   *  rate-floored like any other notification. */
  announce(job, text) {
    if (this.readOnly) return { error: 'registry is read-only in this process' };
    const t = String(text || '').trim().slice(0, 500);
    if (!t) return { error: 'text required: vibespace-job announce "what happened"' };
    this._touch(job, { what: `announced: ${t}`, verb: 'poll' });
    this._notifyOwner(job, { what: `announced: ${t}` });
    this._save();
    return { ok: true };
  }
  /** append the FULL drained notification history to a per-conversation file
   *  so a truncated injection can point the agent at the untruncated record.
   *  Append-only with a head-trim cap; GC'd by age in _gc. */
  spillNotifs(cid, items) {
    try {
      const dir = path.join(this.d.dataDir, 'job-notifications-read');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, String(cid).replace(/[^\w-]/g, '_') + '.md');
      const block = `\n## drained ${new Date().toISOString()}\n` + items.map((n) => `- ${new Date(n.ts).toISOString()} ${n.jobId} ${n.jobName}: ${n.text}`).join('\n') + '\n';
      let prev = '';
      try { prev = fs.readFileSync(file, 'utf-8'); } catch { }
      let out = prev + block;
      if (out.length > 262144) out = out.slice(out.length - 262144); // keep the newest 256KB
      fs.writeFileSync(file, out);
      return file;
    } catch (e) { this.d.log('[jobs] notif spill failed:', e.message); return null; }
  }
  /** honest notify preview for the CREATE response + UI: will the owner
   *  conversation hear back, over which lane, decided by which layer. */
  notifyPreview(job) {
    if (!job) return null;
    const cid = job.owner && job.owner.conversation && job.owner.conversation.id;
    if (!cid) return { enabled: false, mode: 'off', reason: 'no conversation lineage recorded for this job (user-created, or the session id was not known yet at creation)' };
    const eff = M.notifyEffective(job, this.d.groupNotifyFor ? this.d.groupNotifyFor(job) : null, this.d.notifyGlobal ? this.d.notifyGlobal() : true);
    if (!eff.on) return { enabled: false, mode: 'off', source: eff.source, reason: `auto-notify is OFF at the ${eff.source} level` };
    const reachable = this.d.peerReachable ? this.d.peerReachable(cid) : false;
    return {
      enabled: true, source: eff.source,
      mode: reachable ? 'live-message' : 'resume-inject',
      detail: reachable
        ? 'your conversation will receive a message on completion/failure/park/ask (delivery subject to its own inbound settings)'
        : 'your conversation has no live inbox right now — notifications will be stashed and injected when it next resumes',
    };
  }
  /** drain + clear a conversation's stash (called by the injection routes at render time). */
  drainNotifs(cid) {
    if (!cid) return [];
    const q = this.pendingNotifs.get(cid);
    if (!q || !q.length) return [];
    this.pendingNotifs.delete(cid);
    this._dirty = true;
    return q;
  }
  _touch(job, ev) {
    this._dirty = true;
    if (ev) this._event(job, ev.what, ev.verb);
    try { this.d.broadcast('jobs-updated', { id: job.id }); } catch { }
    const ws = this.waiters.get(job.id);
    if (ws && (M.isTerminal(job) || job.state === 'awaiting-user' || job.kind === 'service')) {
      this.waiters.delete(job.id);
      for (const w of ws) { clearTimeout(w.timer); try { w.resolve(); } catch { } }
    }
  }
  _event(job, what, verb) {
    // Viewers see events PASSIVELY at their next injection only (owner call
    // 2.348.0: acceptable because it never wakes anyone and the renderer
    // coalesces per-job announce floods — see renderJobsUpdate).
    this.events.push({ ts: now(), jobId: job.id, name: job.name, what, verb });
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
  }

  // ── identity / process helpers ──────────────────────────────────────────
  _ctlDir(job, runTs) { return path.join(this.logsDir, job.id, String(runTs)); }
  _readStamp(job) {
    const run = job.runs && job.runs[job.runs.length - 1];
    if (!run) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this._ctlDir(job, run.startedAt), 'pid.json'), 'utf-8')); } catch { return null; }
  }
  _verifyAlive(stamp) {
    if (!stamp || !stamp.pid) return false;
    const st = readStarttime(stamp.pid);
    return !!st && st === stamp.starttime && stamp.bootId === bootId();
  }
  _killGroup(job, sig) { // handle-kill with act-time re-verification (B-16d9 law)
    const stamp = this._readStamp(job);
    if (!this._verifyAlive(stamp)) return false;
    try { process.kill(-stamp.pid, sig); return true; } catch { try { process.kill(stamp.pid, sig); return true; } catch { return false; } }
  }

  // ── spawn ───────────────────────────────────────────────────────────────
  _spawn(job, trigger) {
    const runTs = now();
    const ctl = this._ctlDir(job, runTs);
    fs.mkdirSync(ctl, { recursive: true });
    job.state = 'starting';
    job.runs = job.runs || [];
    job.runs.push({ startedAt: runTs, trigger, log: path.join(ctl, 'current.log') });
    if (job.runs.length > 20) job.runs.splice(0, job.runs.length - 20);
    this._save(); // intent-before-spawn, flushed
    const spec = {
      argv: job.cmd.argv, cwd: job.cmd.cwd || process.cwd(),
      env: jobEnv({ ...(job.cmd.env || {}), ...this._secretsFor(job), VIBESPACE_API: this.d.apiBase || `http://127.0.0.1:${process.env.PORT || 3456}`, VIBESPACE_JOB_ID: job.id, VIBESPACE_JOB_TOKEN: this._jobToken(job), PATH: path.join(this.d.dataDir, 'bin') + ':' + (process.env.PATH || '') }),
      logCapBytes: 50 * 1024 * 1024, stdinOpen: !!job.stdinOpen,
    };
    const wrapper = path.join(this.d.dataDir, 'bin', 'job-wrapper.js');
    const child = spawn(process.execPath, [wrapper, ctl, Buffer.from(JSON.stringify(spec)).toString('base64')], { detached: true, stdio: 'ignore' });
    child.unref();
    job.state = 'up';
    job.proc = { pid: child.pid };
    this._touch(job);
    if (job.kind === 'service' && job.publish && (job.ports || []).length) this._ensurePublish(job);
  }
  /** service⇄ports sync (2.343.0): a published service gets a forward + (when
   *  the frp plugin is configured) a public URL; teardown on stop/park. All
   *  best-effort — publish failure never breaks the service itself. */
  async _ensurePublish(job) {
    try {
      const pf = this.d.getPorts && this.d.getPorts();
      if (!pf) return;
      const rec = await pf.forward('__local__', job.ports[0], { label: 'service: ' + job.name });
      job._pfId = rec && rec.id;
      try {
        const r = await pf.publish(job._pfId);
        job.publishedUrl = r && r.publicUrl || null;
      } catch (e) { this.d.log('[jobs] publish unavailable for', job.name, '—', e.message); job.publishedUrl = null; }
      this._touch(job);
    } catch (e) { this.d.log('[jobs] forward failed for', job.name, '—', e.message); }
  }
  async _teardownPublish(job) {
    try {
      const pf = this.d.getPorts && this.d.getPorts();
      if (!pf || !job._pfId) return;
      try { await pf.unpublish(job._pfId); } catch { }
      try { await pf.unforward(job._pfId); } catch { }
      job._pfId = null; job.publishedUrl = null;
      this._touch(job);
    } catch { }
  }
  _secretsFor(job) {
    if (!job.envFrom || !job.envFrom.length) return {};
    try {
      const store = JSON.parse(fs.readFileSync(path.join(this.d.dataDir, 'job-secrets.json'), 'utf-8'));
      const out = {};
      for (const k of job.envFrom) if (store[k] !== undefined) out[k] = String(store[k]);
      return out;
    } catch { return {}; }
  }
  _jobToken(job) {
    if (!job._tokenRaw) { job._tokenRaw = 'jbt_' + crypto.randomBytes(16).toString('hex'); job.tokenHash = crypto.createHash('sha256').update(job._tokenRaw).digest('hex'); }
    return job._tokenRaw;
  }
  jobByToken(raw) {
    if (!raw || !raw.startsWith('jbt_')) return null;
    const h = crypto.createHash('sha256').update(raw).digest('hex');
    for (const j of this.jobs.values()) if (j.tokenHash === h) return j;
    return null;
  }

  // ── boot: adopt-first, then replay ──────────────────────────────────────
  _adoptAndReplay() {
    for (const job of this.jobs.values()) {
      try {
        if (!['up', 'starting', 'awaiting-user'].includes(job.state)) continue;
        const stamp = this._readStamp(job);
        if (this._verifyAlive(stamp)) {
          this.d.log(`[jobs] adopted ${job.id} (${job.name}) pid=${stamp.pid}`);
          if (job.kind === 'service' && job.publish && (job.ports || []).length) setTimeout(() => this._ensurePublish(job), 8000); // ports manager restores at +5.5s
          continue;
        }
        const run = job.runs && job.runs[job.runs.length - 1];
        const exit = this._readExit(job, run);
        if (exit) { this._finalizeRun(job, run, exit, 'boot'); continue; }
        if (stamp && !stamp.bootId) { job.state = 'unverified'; this._touch(job, { what: 'unverified after restart — resolve in the panel' }); continue; }
        // no live process, no exit record ⇒ died with the environment
        if (job.kind === 'service') { job.state = 'down'; this._touch(job); }
        else { if (run && !run.endedAt) { run.endedAt = now(); run.cause = 'env-restart'; run.exit = null; } job.state = 'interrupted'; this._touch(job, { what: 'interrupted (env-restart: the host/pod restarted)' }); }
      } catch (e) { this.d.log(`[jobs] adopt failed for ${job.id}:`, e.message); }
    }
    // one-shot collapse of pre-2.343.3 per-fire child records: keep the newest
    // child per cron, drop older TERMINAL ones (stamp-verified not alive)
    const byParent = new Map();
    for (const j of this.jobs.values()) if (j.cronParent) (byParent.get(j.cronParent) || byParent.set(j.cronParent, []).get(j.cronParent)).push(j);
    for (const [, kids] of byParent) {
      if (kids.length < 2) continue;
      kids.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
      for (const old of kids.slice(1)) {
        if (!['done', 'interrupted', 'failed', 'missed'].includes(old.state)) continue;
        if (this._verifyAlive(this._readStamp(old))) continue;
        this.jobs.delete(old.id); this._dirty = true;
        (this._collapsed = this._collapsed || new Map()).set(old.id, kids[0].id); // poll of a stale id names the survivor
        try { fs.rmSync(path.join(this.logsDir, old.id), { recursive: true, force: true }); } catch { }
      }
    }
    for (const job of this.jobs.values()) {
      try {
        if (job.kind === 'service' && job.desiredUp && job.state === 'down' && !(job.supervise && job.supervise.parkedAt)) this._spawn(job, 'boot');
      } catch (e) { this.d.log(`[jobs] replay failed for ${job.id}:`, e.message); }
    }
  }
  _readExit(job, run) {
    if (!run) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this._ctlDir(job, run.startedAt), 'exit.json'), 'utf-8')); } catch { return null; }
  }
  _finalizeRun(job, run, exit, why) {
    run.endedAt = exit.endedAt || now();
    run.exit = exit.code;
    const untilHit = job._untilHit;
    run.cause = untilHit ? 'ok(until-output)' : exit.signal === 'SIGKILL' && why === 'oom' ? 'oom'
      : job._stopRequested ? 'interrupted' : exit.code === 0 ? 'ok' : job._timedOut ? 'timeout' : 'error';
    delete job._stopRequested; delete job._timedOut; delete job._untilHit;
    if (job.kind === 'service') {
      const dec = M.onServiceExit(job, { uptimeMs: run.endedAt - run.startedAt, now: now() });
      job.supervise = dec.supervise || job.supervise;
      if (dec.park) {
        job.state = 'failed';
        this._teardownPublish(job);
        this._touch(job, { what: `parked after ${M.SUPERVISE.failCap} crashes (exit ${run.exit})` });
        try { this.d.notifyUser({ text: `Service ${job.name} crash-looped and was parked — vibespace-job start ${job.id} to retry`, urgency: 'normal', jobId: job.id, jobName: job.name, ownerCid: job.owner?.conversation?.id || null }); } catch { }
        this._notifyOwner(job, { what: `parked after ${M.SUPERVISE.failCap} crashes (exit ${run.exit}) — start it again once fixed` });
      } else if (dec.restartInMs) {
        job.state = 'down'; this._touch(job);
        const t = setTimeout(() => { try { if (job.desiredUp && job.state === 'down') this._spawn(job, 'restart-policy'); } catch { } }, dec.restartInMs);
        t.unref?.();
      } else { job.state = 'down'; this._touch(job); }
    } else {
      job.state = run.cause === 'interrupted' ? 'interrupted' : run.cause.startsWith('ok') ? 'done' : 'failed';
      // quiet-success is the DEFAULT, not a law (2.346.0, owner decision): the
      // creating agent opts scheduled successes into events+notify with
      // --notify-ok (job.notifyOk, inherited by the cron child via the
      // embedded task spec)
      const routineCronOk = job.cronParent && job.state === 'done' && !job.notifyOk;
      const evText = `${job.state} exit=${run.exit ?? '—'} ${run.cause} (${Math.round((run.endedAt - run.startedAt) / 60000)}m)`;
      this._touch(job, routineCronOk ? null : { what: evText });
      if (job.notifyUser) { try { this.d.notifyUser({ text: `Task ${job.name}: ${job.state} (${run.cause})`, urgency: job.state === 'failed' ? 'normal' : 'low', jobId: job.id, jobName: job.name, ownerCid: job.owner?.conversation?.id || null }); } catch { } }
      // owner auto-notify honors the same quiet-success law: routine scheduled
      // success never messages anyone; agent-stopped ('interrupted') skips too
      // — the owner just did it and a message would echo their own action.
      if (!routineCronOk && job.state !== 'interrupted') this._notifyOwner(job, { what: evText });
    }
  }

  // ── sweeps ──────────────────────────────────────────────────────────────
  async _sweep() {
    if (this.readOnly) return;
    for (const job of this.jobs.values()) {
      if (!['up', 'starting', 'awaiting-user'].includes(job.state)) continue;
      const run = job.runs && job.runs[job.runs.length - 1];
      const stamp = this._readStamp(job);
      if (stamp && job.state === 'starting') { job.state = 'up'; this._touch(job); }
      // a stop that raced the wrapper's first act (no pid stamp yet ⇒ nothing
      // to kill) is honored HERE once the stamp exists — without this, a stop
      // in a job's first few hundred ms silently no-opped (2.350.0 gate catch)
      if (stamp && job._stopRequested && this._verifyAlive(stamp)) {
        this._killGroup(job, 'SIGKILL');
      }
      if (stamp && !this._verifyAlive(stamp)) {
        const exit = this._readExit(job, run) || { code: null, endedAt: now() };
        this._finalizeRun(job, run, exit, 'sweep');
        continue;
      }
      // timeout
      if (job.kind === 'task' && job.timeoutMs && run && !run.endedAt && now() - run.startedAt > job.timeoutMs) {
        job._timedOut = true; this._killGroup(job, 'SIGTERM');
        const t = setTimeout(() => this._killGroup(job, 'SIGKILL'), 10_000); t.unref?.();
      }
      // untilOutput: incremental literal scan, bounded per tick
      if (job.kind === 'task' && job.untilOutput && run && !job._untilHit) this._untilScan(job, run);
      // panel timeout
      const p = job.interaction && job.interaction.pending;
      if (p && p.timeoutS && now() - p.postedAt > p.timeoutS * 1000) {
        job.interaction.answers = job.interaction.answers || [];
        job.interaction.answers.push({ expired: true, version: p.version, ts: now() });
        job.interaction.pending = null;
        if (job.state === 'awaiting-user') job.state = 'up';
        this._resolveAns(job);
        try { this.d.resolveJobAsk && this.d.resolveJobAsk(job.id); } catch { } // expired ask is moot — clear its inbox entry too
        this._touch(job, { what: 'interaction panel expired unanswered', verb: 'answers' });
      }
    }
  }
  _untilScan(job, run) {
    try {
      const logPath = path.join(this._ctlDir(job, run.startedAt), 'current.log');
      const st = fs.statSync(logPath);
      job._untilCursor = job._untilCursor || 0;
      if (st.size < job._untilCursor) job._untilCursor = 0; // rotated
      if (st.size === job._untilCursor) return;
      const len = Math.min(st.size - job._untilCursor, 65536); // per-tick byte budget
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, job._untilCursor); fs.closeSync(fd);
      job._untilCursor += len;
      // literal substring on capped-length text (no agent regex on the main loop)
      if (buf.toString('utf-8').split('\n').some((l) => l.slice(0, 4096).includes(job.untilOutput))) {
        job._untilHit = true;
        this._event(job, 'until-marker hit — completing after grace');
        const grace = Number(process.env.VIBESPACE_JOBS_GRACE_MS) || 30_000; // env knob: tests shrink the until-grace
        const t = setTimeout(() => { this._killGroup(job, 'SIGTERM'); const t2 = setTimeout(() => this._killGroup(job, 'SIGKILL'), 10_000); t2.unref?.(); }, grace);
        t.unref?.();
      }
    } catch { }
  }
  async _cronTick() {
    if (this.readOnly) return;
    for (const job of this.jobs.values()) {
      if (job.kind !== 'cron' || !job.desiredUp) continue;
      try {
        if (job.nextFireAt == null) { job.nextFireAt = M.nextFire(job.schedule, now()); this._dirty = true; continue; }
        if (now() < job.nextFireAt) continue;
        const missedByMs = now() - job.nextFireAt;
        const isCatchUp = missedByMs > 120_000;
        if (isCatchUp && (job.catchUp || 'once') === 'none') {
          if (job.schedule.at) {
            // terminal: park the record so the next tick doesn't re-enter this
            // branch forever (2.344.1 review catch — nextFireAt stayed in the
            // past, so the owner notify re-fired every dedupe window)
            job.state = 'missed'; job.desiredUp = false; job.nextFireAt = null;
            this._touch(job, { what: 'missed its {at} time while the server was down' });
            try { this.d.notifyUser({ text: `Scheduled job ${job.name} MISSED its time (server was down)`, urgency: 'high', jobId: job.id, jobName: job.name, ownerCid: job.owner?.conversation?.id || null }); } catch { }
            this._notifyOwner(job, { what: 'MISSED its scheduled {at} time (server was down) — reschedule if it still matters' });
            continue;
          }
        }
        this._fireCron(job, isCatchUp ? 'boot' : 'cron');
        job.nextFireAt = job.schedule.at ? null : M.nextFire(job.schedule, now());
        if (job.schedule.at) { job.state = 'done'; }
        this._touch(job);
      } catch (e) { this.d.log(`[jobs] cron fire failed for ${job.id}:`, e.message); }
    }
  }
  _fireCron(job, trigger) {
    const a = job.action || {};
    if (a.type === 'notify') {
      const key = (a.text || '').slice(0, 200);
      job._lastNotify = job._lastNotify || {};
      if (job._lastNotify.key === key && now() - job._lastNotify.ts < 6 * 3600e3) { job._lastNotify.count = (job._lastNotify.count || 1) + 1; return; } // dedupe window
      job._lastNotify = { key, ts: now(), count: 1 };
      // USER-INBOX copy is OPT-IN (--notify-user; owner decision 2.363.1,
      // option A): a notify fire's text is usually the AGENT's own reminder
      // ("scan X, report if new") — unconditionally mirroring it to the
      // user's inbox spammed agent-facing instructions at the human
      // (inc-mt27t0bg follow-up report). The agent decides what the user
      // needs and relays via chat/vibespace-ask.
      if (job.notifyUser) {
        try {
          this.d.notifyUser({ text: a.text || job.name, urgency: a.urgency || 'normal', jobId: job.id, jobName: job.name, ownerCid: job.owner?.conversation?.id || null });
          this._notifyLogPush(job, { lane: 'user-inbox', ok: true });
        } catch { }
      }
      // THE 设备运维大师 gap (2.361.5): a notify action only reached the USER
      // inbox — the agent that scheduled its own reminder was never messaged
      // (an agent-created dated obligation woke nobody). Owner-conversation
      // delivery rides the same toggles/rate-floor/stash as every job event.
      this._notifyOwner(job, { what: a.text || job.name });
      this._event(job, 'cron fired: notify');
    } else if (a.type === 'spawn-task') {
      // ONE persistent child per cron (2.343.3, owner report: every fire used
      // to mint a fresh 14-day task record — a 10min cron flooded the panel
      // with ~100 cards/day and spammed the injection channel). Each fire is a
      // RUN in the same child's ring; routine success is SILENT (quiet-success
      // law) — only failures/awaiting-user surface as events.
      let child = [...this.jobs.values()].find((x) => x.cronParent === job.id);
      if (child && job.singleRun !== false && ['up', 'starting', 'awaiting-user'].includes(child.state) && this._verifyAlive(this._readStamp(child))) {
        return; // maxConcurrent:1 — previous run still alive; silent skip (visible in the cron's nextFireAt drift)
      }
      if (!child) {
        child = { ...a.task, id: rid(), kind: 'task', name: `${job.name} run`, owner: job.owner, access: job.access, state: 'starting', runs: [], createdAt: now(), cronParent: job.id };
        this.jobs.set(child.id, child);
      }
      delete child._untilCursor; delete child._untilHit; // fresh run, fresh scan
      this._spawn(child, trigger);
    }
  }
  async _gc() {
    if (this.readOnly) return;
    const cutoff = now() - 14 * 86400e3;
    try { // spill files: age-swept alongside the records they narrate
      const dir = path.join(this.d.dataDir, 'job-notifications-read');
      for (const f of fs.readdirSync(dir)) {
        try { if (fs.statSync(path.join(dir, f)).mtimeMs < cutoff) fs.unlinkSync(path.join(dir, f)); } catch { }
      }
    } catch { }
    for (const [id, job] of this.jobs) {
      const stamp = this._readStamp(job);
      if (this._verifyAlive(stamp)) continue; // NEVER gc live work, regardless of record state
      if (job.kind === 'task' && ['done', 'interrupted'].includes(job.state)) {
        const run = job.runs && job.runs[job.runs.length - 1];
        if (run && run.endedAt && run.endedAt < cutoff) {
          this.jobs.delete(id); this._dirty = true;
          try { fs.rmSync(path.join(this.logsDir, id), { recursive: true, force: true }); } catch { }
        }
      }
    }
  }

  // ── public API (callers pre-authorize via job-model predicates) ─────────
  create(spec, caller) {
    if (this.readOnly || !this.ready) return { error: this.initError ? `jobs engine down: ${this.initError}` : 'jobs engine not ready — retry shortly' };
    const vet = M.vetSpec(spec);
    if (!vet.ok) return { error: vet.error };
    if (spec.kind === 'cron') {
      const v = M.validateSchedule(spec.schedule, { agentCreated: !caller.isUser });
      if (!v.ok) return { error: v.error };
    }
    if (spec.context && Buffer.byteLength(spec.context.payload || '', 'utf-8') > M.CONTEXT_PAYLOAD_CAP) return { error: `context payload exceeds ${M.CONTEXT_PAYLOAD_CAP} bytes — store the brief in a file and reference its path` };
    const visNames = new Set(M.visibleJobs([...this.jobs.values()], caller).map((j) => j.name));
    const { name, renamed } = M.resolveName(spec.name, visNames);
    const job = {
      id: rid(), kind: spec.kind || 'task', name, note: spec.note || '',
      cmd: spec.cmd, envFrom: spec.envFrom || [], restart: spec.restart || 'on-failure',
      health: spec.health || null, ports: spec.ports || [], publish: !!spec.publish,
      singleInstance: spec.singleInstance !== false, timeoutMs: spec.timeoutMs || null,
      untilOutput: spec.untilOutput || null, stdinOpen: !!spec.stdinOpen, notifyUser: !!spec.notifyUser,
      notify: spec.notify === 'on' || spec.notify === 'off' ? spec.notify : undefined, // owner auto-notify override; undefined = inherit group/global
      notifyOk: !!spec.notifyOk, // scheduled successes opt INTO events+notify (quiet-success is only the default)
      schedule: spec.schedule || null, catchUp: spec.catchUp || 'once', action: spec.action || null,
      context: spec.context || null, interaction: { pending: null, answers: [] },
      owner: spec.owner, access: spec.access || { view: 'group', control: 'session' },
      stopWithOwner: !!spec.stopWithOwner, desiredUp: true,
      state: spec.kind === 'cron' ? 'scheduled' : 'starting', proc: null, supervise: { consecutiveFails: 0, parkedAt: null },
      runs: [], createdAt: now(),
    };
    this.jobs.set(job.id, job);
    if (job.kind !== 'cron') {
      try { this._spawn(job, 'manual'); } catch (e) { job.state = 'failed'; this._touch(job); return { error: `spawn failed: ${e.message}`, job: this.snapshot(job) }; }
    } else { job.nextFireAt = M.nextFire(job.schedule, now()); this._touch(job); }
    this._save();
    return { job: this.snapshot(job), renamed };
  }
  stop(job, { force } = {}) {
    if (this.readOnly) return { error: 'registry is read-only in this process' };
    if (job.kind === 'service' || job.kind === 'cron') { job.desiredUp = false; }
    job._stopRequested = true;
    if (job.kind === 'service') this._teardownPublish(job);
    const hadProc = this._killGroup(job, force ? 'SIGKILL' : 'SIGTERM');
    if (hadProc && !force) { const t = setTimeout(() => this._killGroup(job, 'SIGKILL'), 10_000); t.unref?.(); }
    if (!hadProc && job.kind === 'cron') { job.state = 'down'; }
    this._touch(job);
    this._save();
    return { ok: true, hadProc };
  }
  start(job) {
    if (this.readOnly) return { error: 'registry is read-only in this process' };
    job.desiredUp = true;
    job.supervise = { consecutiveFails: 0, parkedAt: null };
    if (job.kind === 'cron') { job.state = 'scheduled'; job.nextFireAt = M.nextFire(job.schedule, now()); this._touch(job); this._save(); return { ok: true }; }
    if (['up', 'starting'].includes(job.state)) return { error: `${job.name} is already running` };
    this._spawn(job, 'manual'); this._save();
    return { ok: true };
  }
  rm(job, { stop, orphan } = {}) {
    if (this.readOnly) return { error: 'registry is read-only in this process' };
    const alive = this._verifyAlive(this._readStamp(job));
    if (alive && !stop && !orphan) return { error: `${job.name} is still running — vibespace-job rm ${job.id} --stop (kill then remove), or --orphan to abandon the live process (tracked nowhere after that)` };
    if (alive && stop) this.stop(job, { force: false });
    if (alive && orphan) this.d.log(`[jobs] ${job.id} (${job.name}) ORPHANED by request — live pid abandoned`);
    this.jobs.delete(job.id); this._dirty = true; this._save();
    try { this.d.resolveJobAsk && this.d.resolveJobAsk(job.id, { onlyAsk: false }); } catch { } // removed job leaves no orphan inbox items
    try { this.d.broadcast('jobs-updated', { id: job.id, removed: true }); } catch { }
    return { ok: true };
  }
  progress(job, text) { job.progress = String(text).slice(0, 300); this._touch(job); return { ok: true }; }
  ask(job, panel) {
    const v = M.validatePanel(panel);
    if (!v.ok) return { error: v.error };
    const version = ((job.interaction && job.interaction.pending && job.interaction.pending.version) || 0) + 1;
    job.interaction = job.interaction || { answers: [] };
    job.interaction.pending = { panel, version, postedAt: now(), timeoutS: panel.timeoutS || 1800 };
    if (job.kind === 'task' && ['up', 'starting'].includes(job.state)) job.state = 'awaiting-user';
    this._touch(job, { what: 'needs your input — open its panel', verb: 'answers' });
    try { this.d.notifyUser({ text: `${job.name} needs your input`, urgency: 'normal', jobId: job.id, jobName: job.name, ownerCid: job.owner?.conversation?.id || null, kind: 'job-interact' }); } catch { }
    this._notifyOwner(job, { what: 'posted an interaction panel and is awaiting an answer' });
    this._save();
    return { ok: true, version };
  }
  answerPanel(job, answers) { // user-side (routes verify user auth)
    const p = job.interaction && job.interaction.pending;
    if (!p) return { error: 'no pending panel' };
    if (answers.version && answers.version !== p.version) return { error: 'stale panel version — reopen the panel' };
    const v = M.validateAnswers(p.panel, answers);
    if (!v.ok) return { error: v.error };
    job.interaction.answers = job.interaction.answers || [];
    const rec = { ...answers, version: p.version, ts: now() };
    job.interaction.answers.push(rec);
    if (job.interaction.answers.length > 50) job.interaction.answers.splice(0, job.interaction.answers.length - 50);
    job.interaction.pending = null;
    if (job.state === 'awaiting-user') job.state = 'up';
    if (job.stdinOpen) { // mirror to the wrapper's answers tail file
      const run = job.runs && job.runs[job.runs.length - 1];
      if (run) { try { fs.appendFileSync(path.join(this._ctlDir(job, run.startedAt), 'answers.jsonl'), JSON.stringify(rec) + '\n'); } catch { } }
    }
    this._resolveAns(job);
    try { this.d.resolveJobAsk && this.d.resolveJobAsk(job.id); } catch { } // clear the needs-your-input inbox entry (owner report: it lingered after submit)
    this._touch(job, { what: 'the user answered its panel', verb: 'answers' });
    this._notifyOwner(job, { what: 'the user answered its interaction panel — vibespace-job answers ' + job.id });
    this._save();
    return { ok: true };
  }
  _resolveAns(job) {
    const ws = this.ansWaiters.get(job.id);
    if (ws) { this.ansWaiters.delete(job.id); for (const w of ws) { clearTimeout(w.timer); try { w.resolve(); } catch { } } }
  }
  async waitFor(map, jobId, ms) {
    ms = Math.min(Math.max(ms || 0, 0), 600_000); // server clamp
    if (!ms) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      const list = map.get(jobId) || [];
      if (list.length >= 8) { clearTimeout(timer); return resolve(); } // waiter cap per job
      list.push({ resolve, timer });
      map.set(jobId, list);
    });
  }
  snapshot(job, { tail = 0 } = {}) {
    const run = job.runs && job.runs[job.runs.length - 1];
    const out = {
      id: job.id, kind: job.kind, name: job.name, note: job.note, state: job.state, publishedUrl: job.publishedUrl || null,
      desiredUp: job.desiredUp, progress: job.progress || null, ports: job.ports, publish: job.publish,
      schedule: job.schedule, nextFireAt: job.nextFireAt || null, context: job.context || null,
      owner: { createdBy: job.owner?.createdBy, groups: job.owner?.groupsSnapshot || [] },
      access: job.access, createdAt: job.createdAt, cronParent: job.cronParent || null,
      notify: job.notify || 'inherit', lastNotify: job.lastNotify || null, subscribersCount: (job.subscribers || []).length,
      notifyLog: (job.notifyLog || []).slice(-8),
      // full creation parameters (2.347.0, owner ask: agents must be able to
      // re-inspect what they registered) — env VALUES stay out (names only)
      cmd: job.cmd ? { argv: job.cmd.argv, cwd: job.cmd.cwd || null, envKeys: Object.keys(job.cmd.env || {}) } : null,
      envFrom: job.envFrom || [], restart: job.restart || null, timeoutMs: job.timeoutMs || null,
      untilOutput: job.untilOutput || null, notifyUser: !!job.notifyUser, notifyOk: !!job.notifyOk,
      catchUp: job.catchUp || null, stopWithOwner: !!job.stopWithOwner, singleInstance: job.singleInstance !== false,
      run: run ? { startedAt: run.startedAt, endedAt: run.endedAt || null, exit: run.exit ?? null, cause: run.cause || null, trigger: run.trigger } : null,
      runsCount: (job.runs || []).length,
      pendingPanel: !!(job.interaction && job.interaction.pending),
      answers: (job.interaction && job.interaction.answers || []).slice(-5),
    };
    if (tail && run) {
      try {
        const logPath = path.join(this._ctlDir(job, run.startedAt), 'current.log');
        const st = fs.statSync(logPath);
        const len = Math.min(st.size, 16384);
        const fd = fs.openSync(logPath, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
        out.logTail = this._redact(buf.toString('utf-8')).split('\n').slice(-tail).join('\n');
      } catch { out.logTail = ''; }
    }
    return out;
  }
  _redact(text) { // literal-redact known secret values (§7)
    try {
      const store = JSON.parse(fs.readFileSync(path.join(this.d.dataDir, 'job-secrets.json'), 'utf-8'));
      for (const v of Object.values(store)) if (v && String(v).length >= 6) text = text.split(String(v)).join('[secret]');
    } catch { }
    return text;
  }
  // injection surfaces (agent-routes): caller-filtered, budgeted in the model
  digestFor(caller, existingBytes) {
    const vis = M.visibleJobs([...this.jobs.values()], caller).filter((j) => j.state !== 'done' || now() - ((j.runs || [])[j.runs?.length - 1]?.endedAt || 0) < 86400e3);
    const withAge = vis.map((j) => ({ ...j, ageHint: this._ageHint(j) }));
    return M.fitDigest(existingBytes, M.renderJobsDigest(withAge), { count: vis.length });
  }
  updatesFor(caller, sinceTs) {
    const visIds = new Set(M.visibleJobs([...this.jobs.values()], caller).map((j) => j.id));
    const evs = this.events.filter((e) => e.ts > sinceTs && visIds.has(e.jobId)).map((e) => ({ id: e.jobId, name: e.name, what: e.what, verb: e.verb }));
    return { text: M.renderJobsUpdate(evs), lastTs: this.events.length ? this.events[this.events.length - 1].ts : sinceTs };
  }
  _ageHint(j) {
    const run = j.runs && j.runs[j.runs.length - 1];
    if (j.kind === 'cron' && j.nextFireAt) return 'next~' + this._hum(j.nextFireAt - now());
    if (run && !run.endedAt) return this._hum(now() - run.startedAt);
    if (run && run.endedAt) return this._hum(now() - run.endedAt) + ' ago';
    return '';
  }
  _hum(ms) { const m = Math.round(Math.abs(ms) / 60000); return m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd'; }
}

module.exports = { JobManager };
