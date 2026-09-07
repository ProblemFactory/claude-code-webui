'use strict';
// BOOT RESTORE (decomposition #7): everything that brings sessions back after
// a server restart — the legacy-home project-dir migration self-heal,
// restoreSessions (dtach socket scan → re-attach + meta recovery), the R6
// boot re-open of daemon pipe sessions, and the B-1525 orphaned remote-keeper
// re-adoption sweep. Extracted VERBATIM. ORCH tier; runs once at boot.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { execFileSync, spawn } = require('child_process');
const { createMessageManager } = require('../normalizers');
const { cwdToProjectDir, dedupWebuiSockets } = require('../session-store');
const { pickCodexThreadCandidate } = require('../ws-handler');
const { fdScanShellFns } = require('../writer-sweep.js');

const { mk } = require('./lazy.js');

function create({ rootDir, PORT, BUFFERS_DIR, META_DIR, SOCKETS_DIR, DTACH_CMD,
  ENV_CMD, NODE_CMD, CHAT_WRAPPER, activeSessions, sessionCounterRef,
  attachToDtach, setupSessionPty, readSessionMeta, writeSessionMeta,
  deleteSessionMeta, broadcastToSession, broadcastActiveSessions,
  refreshWebuiPids, sbNoteServerOp, getHosts, getDialBridge }) {
  const hosts = mk(getHosts);
  const dialBridge = mk(getDialBridge);
  const ensureDir = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };
// ── Personalized-username migration self-heal (2.236.1, userW's real
// incident): the 3.5.0 image renames the container user vibe→<name> and
// symlinks /home/vibe → /home/<name>, which covers every recorded ABSOLUTE
// path — but claude encodes its per-project transcript dirs from the
// RESOLVED cwd, so pre-migration transcripts live under
// projects/-home-vibe-* while post-migration resumes look in
// -home-<name>-* → "No conversation found with session ID". Heal at boot:
// rename each -home-vibe-* dir to the new encoding and leave the old name
// as a symlink (VibeSpace's own cwdToProjectDir over recorded /home/vibe
// cwds keeps working through it). Idempotent; collisions skipped with a log.
function migrateLegacyHomeProjects() {
  try {
    const home = os.homedir();
    if (path.basename(home) === 'vibe') return;
    let st; try { st = fs.lstatSync('/home/vibe'); } catch { return; }
    if (!st.isSymbolicLink()) return;
    const projectsDir = path.join(home, '.claude', 'projects');
    const newPrefix = cwdToProjectDir(home); // e.g. -home-userW
    let names; try { names = fs.readdirSync(projectsDir); } catch { return; }
    let n = 0;
    for (const d of names) {
      if (!d.startsWith('-home-vibe-')) continue;
      const full = path.join(projectsDir, d);
      let ds; try { ds = fs.lstatSync(full); } catch { continue; }
      if (!ds.isDirectory()) continue; // already a symlink from a prior run
      const target = newPrefix + '-' + d.slice('-home-vibe-'.length);
      const targetFull = path.join(projectsDir, target);
      if (fs.existsSync(targetFull)) { console.warn(`[migrate] projects collision, left in place: ${d}`); continue; }
      try {
        fs.renameSync(full, targetFull);
        fs.symlinkSync(target, full);
        n++;
      } catch (e) { console.warn(`[migrate] projects rename failed for ${d}: ${e.message}`); }
    }
    if (n) console.log(`[migrate] personalized-username: re-encoded ${n} claude project dir(s) -home-vibe-* -> ${newPrefix}-* (old names symlinked)`);
  } catch (e) { console.warn('[migrate] legacy home projects check failed:', e.message); }
}

function restoreSessions() {
  ensureDir(SOCKETS_DIR);
  ensureDir(BUFFERS_DIR);
  const sockets = fs.readdirSync(SOCKETS_DIR).filter(f => f.startsWith('cw-'));
  if (!sockets.length) return;

  console.log(`  Found ${sockets.length} existing session(s), reconnecting...`);
  // Dial-session bridges live in THIS process — recreate them on the SAME
  // recorded port so the surviving wrapper's attach reconnect lands (the
  // host-mounts tunnel re-own pattern). Must happen before wrappers retry.
  for (const sockFile of sockets) {
    try {
      // Metas are keyed by the FULL sockName (cw-N-TS) — the old cw-stripped
      // read NEVER matched, so no dial bridge was ever restored and every
      // dial session died on any server restart (2.219.0 audit CRITICAL;
      // wrapper reconnected forever against the dead port). Bridge keyed by
      // the recorded webui id so kill's dialBridge.close(sessionId) finds it.
      const m = readSessionMeta(sockFile) || {};
      if (m.dialDeviceId && m.bridgePort) {
        dialBridge.ensure({ sid: m.webuiSessionId || sockFile, deviceId: m.dialDeviceId, port: m.bridgePort })
          .catch((e) => console.warn('[dial-bridge] restore failed:', e.message));
      }
    } catch { }
  }
  // Dedup by conversation BEFORE adoption: a plain `claude --resume` reuses the
  // conversation id, so a resume of a session whose claude had already died
  // minted a SECOND dtach session for the SAME claudeSessionId → two sidebar
  // cards (real owner report; userW's local double-writer class). Keep one
  // socket per conversation (alive-claude > dead, then newest), retire the rest.
  const dedupMetas = [];
  for (const sockFile of sockets) {
    let m; try { m = readSessionMeta(sockFile); } catch { continue; }
    if (m && m.claudeSessionId) dedupMetas.push({ sockFile, m });
  }
  // ONE /proc pass: which conversations have a live claude holding their JSONL?
  // (a lingering dtach husk whose claude crashed has a DEAD conversation and
  // must lose to a live one).
  //
  // B-3185: this used to fork a `readlink` PER FD — 405,735 of them on the dev
  // box, ~6.4 minutes — so it ALWAYS blew its own 6s timeout, and the catch
  // turned that into a silent empty set. (The forks were the ONLY problem: its
  // fd-level glob fed a SHELL for-loop, which expands in the shell's own memory
  // and never reaches execve, so ARG_MAX never applied — r1 said it did, which
  // was wrong. ARG_MAX bounds the batched scan's `ls` argv instead, which is
  // why THAT is chunked.) It now runs THE batched fd scan the writer sweep uses
  // — 3.0s at 3678 processes — and a failure SAYS SO.
  //
  // HONEST LIMIT, measured on the installed CLI (2.1.226, native binary): a
  // live claude does NOT keep its transcript open — it appends and closes, and
  // a machine-wide scan found ZERO processes holding any
  // ~/.claude/projects/**.jsonl. So this answers "nobody" for current claude
  // however fast it runs; it only sees a holder that really exists. The CLI's
  // OWN registry (~/.claude/sessions/<pid>.json, sessionId + pid + procStart)
  // is the accurate liveness source — deliberately NOT swapped in here,
  // because retiring is destructive (SIGTERM + unlink the dtach socket) and
  // changing which socket boot destroys is its own decision, not a rider on a
  // performance fix. Backlog: give claudeAlive the registry, keyed with the
  // procStart counter-capture so pid reuse cannot fake it.
  let liveConvos = new Set();
  const dedupIds = [...new Set(dedupMetas.map(({ m }) => m.claudeSessionId).filter((s) => /^[\w-]+$/.test(s || '')))];
  if (dedupIds.length) {
    try {
      const pat = `/(${dedupIds.join('|')})[.]jsonl`;
      const script = `${fdScanShellFns()}\nvs_fd_scan '${pat}' | cut -f2`;
      const out = execFileSync('sh', ['-c', script], { encoding: 'utf-8', timeout: 20000 });
      const held = out.split('\n');
      for (const id of dedupIds) if (held.some((t) => t.includes(`/${id}.jsonl`))) liveConvos.add(id);
    } catch (e) {
      // Degrading to "nobody is live" is survivable (the dedup falls back to
      // createdAt), but it must never be silent again — that is what hid this
      // for as long as it was broken.
      console.warn('[boot-restore] live-conversation fd scan failed:', e?.message || e);
    }
  }
  // REMOTE sockets: the /proc scan can't see a claude running ON THE HOST, so
  // claudeAlive was unconditionally false and duplicate sockets of one remote
  // conversation could retire the wrong one (audit 2.192.0/B-82ea). Substitute
  // the LOCAL transport liveness (dtach socket has an owner = the ssh/agentd
  // pipe survived the restart) — the same signal the adoption loop uses below.
  const remoteSockAlive = new Set();
  for (const { sockFile, m } of dedupMetas) {
    if (!m.host) continue;
    try {
      const out = execFileSync('fuser', [path.join(SOCKETS_DIR, sockFile)], { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
      if (out.trim().length > 0) remoteSockAlive.add(sockFile);
    } catch {}
  }
  const { retire: retireSockets } = dedupWebuiSockets(dedupMetas.map(({ sockFile, m }) => ({
    sockFile, backend: m.backend || 'claude', host: m.host || 'local',
    claudeSessionId: m.claudeSessionId, createdAt: m.createdAt || 0,
    claudeAlive: m.host ? remoteSockAlive.has(sockFile) : liveConvos.has(m.claudeSessionId),
  })));

  for (const sockFile of sockets) {
    const socketPath = path.join(SOCKETS_DIR, sockFile);
    try { fs.statSync(socketPath); } catch { continue; }

    // Verify socket is live — check if any process owns it
    let socketAlive = false;
    try {
      const out = execFileSync('fuser', [socketPath], { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
      socketAlive = out.trim().length > 0;
    } catch {
      // fuser returns non-zero if no process found, also try pgrep
      try {
        execFileSync('pgrep', ['-f', socketPath], { encoding: 'utf-8', timeout: 2000 });
        socketAlive = true;
      } catch { socketAlive = false; }
    }

    if (!socketAlive) {
      console.log(`  ✗ Dead socket: ${sockFile} — cleaning up`);
      try { fs.unlinkSync(socketPath); } catch {}
      // B-1525 (2.219.0): a REMOTE session's meta holds the ONLY local record
      // of its keeper sid / dial device — the remote half (keeper daemon,
      // device pipe session) survives a pod-level death, and deleting the
      // meta here orphaned it forever (userL's h200 keeper claudes needed
      // manual surgery). Keep those metas tagged orphanedAt for re-adopt
      // (resume host-inference + findKeeperFor consume them); local-only
      // sessions keep the old cleanup.
      try {
        const dm = readSessionMeta(sockFile) || {};
        if ((dm.host || dm.dialDeviceId) && !dm.orphanedAt) {
          writeSessionMeta(sockFile.replace(/\.orphan$/, ''), { ...dm, orphanedAt: Date.now() });
          const op = path.join(META_DIR, sockFile + '.json');
          fs.renameSync(op, op + '.orphan');
          console.log(`    ↳ remote session meta preserved as orphan (${dm.keeperSid || dm.dialDeviceId || dm.host})`);
          continue;
        }
      } catch { }
      deleteSessionMeta(sockFile);
      continue;
    }

    const meta = readSessionMeta(sockFile);
    const id = meta.webuiSessionId || ('sess-' + (++sessionCounterRef.value) + '-' + Date.now());

    // stale duplicate of a conversation another socket owns — do NOT adopt (two
    // cards); retire the husk so it can't double-write the JSONL. SIGTERM the
    // socket's dtach session (claude, if any, is the older/losing writer) then
    // clean socket + buffer + meta.
    if (retireSockets.has(sockFile)) {
      console.log(`  ⤫ Duplicate of ${meta.claudeSessionId} — retiring stale ${sockFile}`);
      try {
        for (const p of execFileSync('pgrep', ['-f', socketPath], { encoding: 'utf-8', timeout: 2000 }).split('\n')) {
          const pid = Number(p.trim());
          if (pid > 1 && pid !== process.pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
        }
      } catch {}
      try { fs.unlinkSync(socketPath); } catch {}
      try { fs.unlinkSync(path.join(BUFFERS_DIR, id + '.buf')); } catch {}
      try { fs.unlinkSync(path.join(BUFFERS_DIR, id + '.json')); } catch {}
      deleteSessionMeta(sockFile);
      continue;
    }

    // Detect mode and streaming state from wrapper metadata
    let sessionMode = meta.mode || 'terminal';
    let wrapperStreaming = false;
    let wrapperGoal = null, wrapperGoalStatus = null, wrapperGoalElapsed = 0, wrapperGoalTokens = 0;
    let bareRemote = false;
    let restoredRemote = null;
    let wrapperAgentTasks = null;
    const wrapperFiles = require('./wrapper-files.js').resolveWrapperFiles(BUFFERS_DIR, id, path.join(SOCKETS_DIR, sockFile));
    try {
      const wrapperMeta = JSON.parse(fs.readFileSync(wrapperFiles.sidecar, 'utf-8'));
      if (wrapperMeta.mode === 'chat') sessionMode = 'chat';
      if (wrapperMeta.streaming != null) wrapperStreaming = !!wrapperMeta.streaming;
      if (wrapperMeta.goal) { wrapperGoal = wrapperMeta.goal; wrapperGoalStatus = wrapperMeta.goalStatus || null; wrapperGoalElapsed = wrapperMeta.goalElapsed || 0; wrapperGoalTokens = wrapperMeta.goalTokensUsed || 0; }
      // Agent's live todo list survives the restart (2.219.0 audit — the
      // card's progress pill/Steps went blank until the next TodoWrite)
      if (Array.isArray(wrapperMeta.todos) && wrapperMeta.todos.length) {
        const done = wrapperMeta.todos.filter((t) => t?.status === 'completed').length;
        const cur = wrapperMeta.todos.find((t) => t?.status === 'in_progress');
        var wrapperTodos = { done, total: wrapperMeta.todos.length, current: cur ? String(cur.content || cur.activeForm || cur.step || '').slice(0, 140) : null };
      }
      // Agents still RUNNING per the wrapper's task map (chat-wrapper keeps
      // them until task_notification) need their JSONL watchers re-armed —
      // startSubagentWatcher's only other call site is the live task_started
      // parse, so an agent spanning the restart went monitoring-dark (frozen
      // tool card, empty live View Log) until it completed.
      if (sessionMode === 'chat' && wrapperMeta.tasks) {
        const running = Object.entries(wrapperMeta.tasks)
          .filter(([, t]) => t && t.type === 'agent' && t.status === 'running' && t.id)
          .map(([tuid, t]) => ({ tuid, agentId: t.id }));
        if (running.length) wrapperAgentTasks = running;
      }
      // B-0845: a REMOTE chat session restored WITHOUT the wrapper's remote
      // field predates the keeper (2.124.0) — claude hangs bare off the ssh
      // pipe and one network wobble kills the conversation. Surface it.
      if (meta.host && sessionMode === 'chat' && !wrapperMeta.remote) bareRemote = true;
      if (wrapperMeta.remote && wrapperMeta.remote.state && wrapperMeta.remote.state !== 'connected') {
        restoredRemote = { state: wrapperMeta.remote.state, attempts: wrapperMeta.remote.attempts || 0, at: wrapperMeta.remote.at || Date.now() };
      }
    } catch {}

    let savedBuffer = '';
    try { savedBuffer = fs.readFileSync(wrapperFiles.buf, 'utf-8'); } catch {}

    const session = {
      mode: sessionMode,
      pty: null, clients: new Map(),
      cwd: meta.cwd || os.homedir(),
      host: meta.host || null,
      _bareRemote: bareRemote,
      keeperSid: meta.keeperSid || null,
      _agentdSession: !!meta.agentdSession, // transport mechanism (2.219.0 — kill branch correctness)
      _cwdRecreated: !!meta.cwdRecreated, // B-7812: undelivered recreated-cwd agent notice survives restarts
      _remoteState: restoredRemote,
      _todos: (typeof wrapperTodos !== 'undefined' && wrapperTodos) || null,
      _restoreAgentTasks: wrapperAgentTasks, // re-armed post-attach (setupSessionPty defines the watcher)
      _pendingEditor: meta.pendingEditor || null, // Ctrl+G edit in flight — re-broadcast on attach
      _prevGoal: meta.prevGoal || null, // /goal resume works across restarts
      _forkRequested: !!meta.forkRequested, // pending fork-id adoption survives restart
      _resumeSpawn: !!meta.resumeSpawn, // implicit-fork adoption stays armed across restarts (B-b87b)
      _sawFirstId: !!meta.sawFirstId,
      _dialDeviceId: meta.dialDeviceId || null,
      _bridgePort: meta.bridgePort || null,
      _dialReversePort: meta.dialReversePort || null, // VIBESPACE_API back-tunnel, re-owned at the next dial-in (audit #49)
      hostName: meta.hostName || null,
      name: meta.name || sockFile,
      createdAt: meta.createdAt || Date.now(),
      backend: meta.backend || 'claude',
      backendSessionId: meta.backendSessionId || meta.claudeSessionId || null,
      claudeSessionId: meta.claudeSessionId || null,
      sourceKind: meta.sourceKind || null,
      agentKind: meta.agentKind || 'primary',
      agentRole: meta.agentRole || '',
      agentNickname: meta.agentNickname || '',
      parentThreadId: meta.parentThreadId || null,
      forkedFrom: meta.forkedFrom || null,
      // Permission mode isn't recoverable from the JSONL (init records are
      // stdout-only) — restore what the session was launched with
      _permissionMode: meta.permissionMode || null,
      _effort: meta.effort || null,
      _modelOrigin: meta.modelOrigin || null, _effortOrigin: meta.effortOrigin || null, // B-6b6d: the spawn's model/effort ORIGIN survives a restart (else the panel's honest row degrades to a guess)
      _outputStyle: meta.outputStyle || null, // 2.369.58: the chip must not report "default" for a session really running a style
      _modelLocked: !!meta.modelLocked,
      _lockedModel: meta.lockedModel || null,
      agentToken: meta.agentToken || null, // vibespace-status auth survives restarts
      _initialGroupId: meta.taskId || null, // group spawned into; belonging is live-derived, this only covers the pre-bind window
      _accountId: meta.accountId || null, // billing identity the session was spawned with (badge only — env lives in the surviving dtach process)
      _authAtSpawn: meta.authAtSpawn || null,
      _apiKeySource: meta.apiKeySource || null, // CLI-confirmed auth (init record); backfilled from the buffer below when absent
      sockName: sockFile,
      socketPath,
      buffer: savedBuffer,
      _isStreaming: wrapperStreaming,
      _goal: wrapperGoal,
      _goalStatus: wrapperGoalStatus,
      _goalElapsed: wrapperGoalElapsed,
      _goalTokensUsed: wrapperGoalTokens,
    };
    // Create normalizer for chat sessions (populated on first attach from JSONL + buffer)
    if (sessionMode === 'chat') {
      session._normalizer = createMessageManager(session.backend || 'claude', id);
      session._normEpoch = Date.now();
      session._normalizer.onOp((op) => {
        try { if (session.host && session.keeperSid) sbNoteServerOp(session.host, session.keeperSid, op); } catch { } // step-2 dark tap (the daemon streams by ITS sid = keeperSid)
        broadcastToSession(session, id, { type: 'msg', sessionId: id, ...op });
      });
    }
    activeSessions.set(id, session);
    session._webuiId = id; // per-session pool link key (plan C) — the id the session is registered under
    session._spawnModel = meta.spawnModel || null; session._pickedModel = meta.pickedModel || null; session._pickedModelAt = meta.pickedModelAt || 0; // plan C model ladder survives restarts
    session._msgReachability = meta.msgReachability || null; // Channels v1 per-session reach override survives restarts
    attachToDtach(id, socketPath, session);

    console.log(`  ✓ Reconnected: ${session.name} (${session.cwd})`);
  }

  // Populate webuiPids cache after all sessions are restored
  refreshWebuiPids();

  // Backfill billing identity for sessions restored WITHOUT a recorded
  // apiKeySource (spawned before tracking): chat sessions carry the init
  // record in their buffer (grep the last occurrence — bounded child
  // process, off the boot critical path); terminal sessions get a /proc env
  // probe (env key = definite API). One broadcast when done.
  setTimeout(() => {
    const { execFile } = require('child_process');
    let pending = 0, changed = false;
    const finish = () => { if (--pending === 0 && changed) broadcastActiveSessions(); };
    for (const [id, s] of activeSessions) {
      if (s.backend !== 'claude' || s._apiKeySource) continue;
      const buf = path.join(BUFFERS_DIR, `${id}.buf`);
      pending++;
      execFile('sh', ['-c', `grep -o 'apiKeySource":"[^"]*"' ${JSON.stringify(buf)} 2>/dev/null | tail -1`], { timeout: 20000 }, (err, out) => {
        const m = /apiKeySource":"([^"]*)"/.exec(String(out || ''));
        if (m) {
          s._apiKeySource = m[1];
          if (s.sockName) { try { writeSessionMeta(s.sockName, { ...(readSessionMeta(s.sockName) || {}), apiKeySource: m[1] }); } catch { } }
          changed = true;
        } else if (!s._authAtSpawn && s._childPid) {
          // terminal session: env probe (only the env-key case is provable)
          try {
            const env = fs.readFileSync(`/proc/${s._childPid}/environ`, 'utf-8');
            if (env.includes('ANTHROPIC_API_KEY=')) { s._apiKeySource = 'ANTHROPIC_API_KEY'; changed = true; }
          } catch { }
        }
        finish();
      });
    }
    if (!pending) { /* nothing to backfill */ }
  }, 3000);

  // Re-arm live subagent monitoring for agents that span the restart: the
  // wrapper meta's task map (captured into _restoreAgentTasks above) still
  // lists them as running, but startSubagentWatcher's only live call site is
  // the task_started stream parse. The handle lands on the session when
  // setupSessionPty runs — async for agentd-restored sessions, hence the
  // delayed pass + one late retry.
  const rearmSubagentWatchers = (retry) => {
    for (const [, s] of activeSessions) {
      const tasks = s._restoreAgentTasks;
      if (!tasks || !tasks.length) continue;
      if (typeof s._startSubagentWatcher !== 'function') { if (!retry) s._restoreAgentTasks = null; continue; }
      s._restoreAgentTasks = null;
      for (const t of tasks) { try { s._startSubagentWatcher(t.tuid, t.agentId); } catch {} }
    }
  };
  setTimeout(() => rearmSubagentWatchers(true), 5000);
  setTimeout(() => rearmSubagentWatchers(false), 20000);

  // Re-arm the backend-id capture for restored sessions still missing their id
  // (server restarted inside the create-time ~2-17s/60s capture window — those
  // retry chains died with the old process). Claude CHAT self-heals via the
  // stream parser's first-capture on the next line; claude TERMINAL and codex
  // have NO other backfill and stayed id-less for life (sessionKey '' → no
  // status/config/star binding, no transcript link). LOCAL sessions only —
  // scanning the local lock dir for a remote session false-matches (2.156.2).
  // Idempotent: same claimed-id + cwd + startedAt guards as the create chains.
  const recaptureIds = (attempts) => {
    let changed = false, missing = false;
    const claimed = new Set();
    for (const [, s] of activeSessions) { if (s.backend === 'claude' && s.claudeSessionId) claimed.add(s.claudeSessionId); }
    for (const [id, s] of activeSessions) {
      if (s.host) continue;
      if (s.backend === 'claude' && !s.claudeSessionId) {
        try {
          const { SESSIONS_DIR } = require('../session-store');
          for (const f of fs.readdirSync(SESSIONS_DIR).filter((n) => n.endsWith('.json'))) {
            const lockData = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
            if (claimed.has(lockData.sessionId)) continue;
            if (lockData.cwd === s.cwd && lockData.startedAt > s.createdAt - 5000) {
              s.claudeSessionId = lockData.sessionId;
              s.backendSessionId = lockData.sessionId;
              claimed.add(lockData.sessionId);
              if (s.sockName) { try { writeSessionMeta(s.sockName, { ...(readSessionMeta(s.sockName) || {}), backendSessionId: s.backendSessionId, claudeSessionId: s.claudeSessionId }); } catch {} }
              changed = true;
              break;
            }
          }
        } catch {}
        if (!s.claudeSessionId) missing = true;
      } else if (s.backend === 'codex' && !s.backendSessionId) {
        try {
          const matched = pickCodexThreadCandidate({ activeSessions, webuiSessionId: id, cwd: s.cwd, createdAt: s.createdAt, baselineThreadIds: null, pathLib: path });
          // no create-time baseline here — refuse clearly-stale threads (the
          // same startedAt window the claude lock guard uses)
          if (matched && (Number(matched.startedAt) || 0) > (s.createdAt || 0) - 5000) {
            s.backendSessionId = matched.backendSessionId || matched.sessionId || null;
            s.claudeSessionId = null;
            if (matched.name) s.name = matched.name;
            if (matched.cwd) s.cwd = matched.cwd;
            if (s.backendSessionId && s.sockName) {
              try { writeSessionMeta(s.sockName, { ...(readSessionMeta(s.sockName) || {}), name: s.name, cwd: s.cwd, backendSessionId: s.backendSessionId, claudeSessionId: null }); } catch {}
              changed = true;
            }
          }
        } catch {}
        if (!s.backendSessionId) missing = true;
      }
    }
    if (changed) broadcastActiveSessions();
    if (missing && attempts > 1) setTimeout(() => recaptureIds(attempts - 1), 2000);
  };
  setTimeout(() => recaptureIds(5), 4000);

  // Warn about surviving sessions whose CLI is still running in child-session
  // mode (spawned while the server env carried CLAUDE_CODE_CHILD_SESSION —
  // e.g. a pre-fix server restarted from inside a Claude session). Those CLIs
  // keep their poisoned env until recreated: their conversations are NOT being
  // written to any transcript and will be lost on terminate+resume.
  if (process.platform === 'linux') {
    setTimeout(() => {
      const affected = [];
      for (const [id, s] of activeSessions) {
        const pid = s._childPid;
        if (!pid) continue;
        try {
          const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
          if (env.includes('CLAUDE_CODE_CHILD_SESSION=1')) affected.push(`${s.name} (${s.cwd})`);
        } catch {}
      }
      if (affected.length) {
        console.warn(`[env] ${affected.length} running session(s) were spawned with CLAUDE_CODE_CHILD_SESSION=1 and are NOT persisting transcripts — finish + recreate them to restore persistence:\n  - ${affected.join('\n  - ')}`);
      }
    }, 3000); // after refreshWebuiPids has populated _childPid
  }
}

// ── R6: boot RE-OPEN of local daemon PIPE sessions (agentdPipe metas) ────────
// These sessions have NO dtach socket — the daemon supervises the wrapper and
// survives server restarts by itself. Restore = re-open the pipe by sid with
// the daemon's offset-reattach; failure leaves the meta for the view-only
// rescue (never deletes — the transcript is intact either way).
function restoreAgentdPipeSessions() {
  let metas = [];
  try { metas = fs.readdirSync(META_DIR).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const mf of metas) {
    let meta = null; try { meta = JSON.parse(fs.readFileSync(path.join(META_DIR, mf), 'utf-8')); } catch { continue; }
    if (!meta?.agentdPipe) continue;
    const sockFile = mf.slice(0, -5);
    const id = 'sess-' + sockFile.replace(/^cw-/, '');
    if (activeSessions.has(id)) continue;
    const session = {
      mode: 'chat', backend: meta.backend || 'claude', cwd: meta.cwd || os.homedir(),
      name: meta.name || 'Session', createdAt: meta.createdAt || Date.now(), sockName: sockFile,
      clients: new Map(), buffer: '', agentToken: meta.agentToken || null, taskId: meta.taskId || null,
      _accountId: meta.accountId || null, claudeSessionId: meta.claudeSessionId || null,
      backendSessionId: meta.claudeSessionId || meta.backendSessionId || null,
      agentdSession: true, keeperSid: id, agentdPipe: true,
      _permissionMode: meta.permissionMode || null, _effort: meta.effort || null,
      _modelOrigin: meta.modelOrigin || null, _effortOrigin: meta.effortOrigin || null, // B-6b6d: the spawn's model/effort ORIGIN survives a restart (else the panel's honest row degrades to a guess)
      _outputStyle: meta.outputStyle || null,
      _spawnModel: meta.spawnModel || null, _pickedModel: meta.pickedModel || null, _pickedModelAt: meta.pickedModelAt || 0,
      _msgReachability: meta.msgReachability || null,
    };
    hosts.device(null).then(async (dm) => {
      let offset = 0;
      try { offset = fs.statSync(path.join(BUFFERS_DIR, id + '.buf')).size; } catch { }
      const h = await dm.openPipeSession({ sid: id, offset });
      const shim = {
        pid: h.pid || -1,
        onData: (cb) => { h.onData = (buf) => cb(buf.toString('utf-8')); },
        onExit: (cb) => { h.onExit = (code) => cb({ exitCode: code ?? 0 }); },
        write: (str) => { try { h.write(str); } catch { } },
        resize: () => { }, kill: () => { try { h.kill(); } catch { } },
      };
      activeSessions.set(id, session);
      session._webuiId = id;
      setupSessionPty(session, id, shim);
      console.log(`[restore] re-opened daemon pipe session ${id} "${session.name}"`);
    }).catch((e) => console.warn(`[restore] daemon pipe session ${id} not re-opened (view-only rescue covers it): ${e.message}`));
  }
}
try { restoreAgentdPipeSessions(); } catch (e) { console.warn('[restore] agentd pipe scan failed:', e.message); }

// ── B-1525 second half: boot AUTO RE-ADOPT of orphaned remote keeper sessions ──
// Pod-level death kills every local dtach; the dead-socket cleanup preserves
// REMOTE sessions' metas as .orphan files. For each orphan whose keeper child
// (the remote claude) is STILL ALIVE on its ssh host, respawn the local
// transport half attached to the SAME keeper sid — the session comes back
// LIVE by itself (the userL manual-surgery class, automated).
// Attach ≠ create, which keeps this spawn MINIMAL and safe:
//  - keeper `run <sid> <offset>` on a LIVE sid only ATTACHES (never spawns a
//    claude) → billing env and tools shipping are irrelevant here;
//  - session.agentToken REUSES the original vsst_ value, so the remote
//    claude's baked env token maps straight onto the re-adopted session;
//  - the remote claude's baked VIBESPACE_API port is read from its
//    /proc/<pid>/environ and the new `ssh -R` binds the SAME port, so the
//    agent tools' back-tunnel heals completely.
async function readoptOrphanKeeperSessions() {
  let files = [];
  try { files = fs.readdirSync(META_DIR).filter((f) => f.endsWith('.json.orphan')); } catch { return; }
  if (!files.length) return;
  const { execFile } = require('child_process');
  const sshOut = (h, script) => new Promise((resolve) => {
    execFile('ssh', [...hosts.sshArgs(h, { multiplex: true }), '--', script],
      { timeout: 15000, maxBuffer: 256 * 1024 }, (err, out) => resolve(err ? null : String(out || '')));
  });
  let adopted = 0;
  for (const f of files) {
    if (adopted >= 8) break; // per-boot cap — a huge orphan pile shouldn't storm hosts
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(META_DIR, f), 'utf-8')); } catch { continue; }
    if (!meta?.host || !meta.keeperSid || meta.mode !== 'chat' || (meta.backend || 'claude') !== 'claude') continue;
    const h = hosts.get?.(meta.host);
    if (!h || h.transport === 'dial') continue; // dial pipe re-adopt is a separate path
    // A live session already tracking this conversation wins — never double up
    let dup = false;
    for (const [, s] of activeSessions) {
      if (meta.claudeSessionId && (s.claudeSessionId === meta.claudeSessionId || s.backendSessionId === meta.claudeSessionId)) { dup = true; break; }
    }
    if (dup) continue;
    // Liveness probe: keeper meta → childPid alive → baked VIBESPACE_API port
    const probe = `K="$HOME/.vibespace/run/${meta.keeperSid}.json"; [ -e "$K" ] || exit 3; `
      + `P=$(sed -n 's/.*"childPid":\\([0-9]*\\).*/\\1/p' "$K" | head -1); `
      + `[ -n "$P" ] && kill -0 "$P" 2>/dev/null || exit 4; echo "PID=$P"; `
      + `tr '\\0' '\\n' < /proc/$P/environ 2>/dev/null | grep '^VIBESPACE_API=' | head -1`;
    const out = await sshOut(h, probe);
    if (!out || !out.includes('PID=')) continue; // host down or claude gone — leave the orphan for a later boot
    const rport = Number((/VIBESPACE_API=http:\/\/127\.0\.0\.1:(\d+)/.exec(out) || [])[1]) || null;

    // sockName DERIVED from the id (2.304.0 root fix — one identity, not two;
    // see the ws-handler create path)
    const id = 'sess-' + (++sessionCounterRef.value) + '-' + Date.now();
    const sockName = 'cw-' + id.slice('sess-'.length);
    const socketPath = path.join(SOCKETS_DIR, sockName);
    const bufFile = path.join(BUFFERS_DIR, id + '.buf');
    const metaFileW = path.join(BUFFERS_DIR, id + '.json');
    const inner = `export PATH="$HOME/.vibespace/bin:$HOME/.local/bin:$PATH"; [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; `
      + `exec node "$HOME/.vibespace/bin/vibespace-remote-keeper" run ${meta.keeperSid} __VS_OFFSET__`;
    const sshArgs = [...hosts.sshArgs(h, rport ? { reverse: `${rport}:127.0.0.1:${PORT}` } : {}), '-T', '--', inner];
    let ptyProc;
    try {
      ptyProc = pty.spawn(DTACH_CMD, ['-c', socketPath, '-E', '-r', 'none',
        NODE_CMD, CHAT_WRAPPER, bufFile, metaFileW,
        ENV_CMD, `CLAUDE_WEBUI_PORT=${PORT}`, `CLAUDE_WEBUI_SESSION_ID=${id}`,
        `TERM=xterm-256color`, 'ssh', ...sshArgs,
      ], {
        name: 'xterm-256color', cols: 190, rows: 45, cwd: os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color', VIBESPACE_REMOTE_SID: id },
      });
    } catch (e) { console.warn(`[readopt] spawn failed for ${meta.keeperSid}: ${e.message}`); continue; }
    const session = {
      mode: 'chat', pty: null, clients: new Map(),
      cwd: meta.cwd || os.homedir(),
      host: meta.host, hostName: meta.hostName || null,
      keeperSid: meta.keeperSid,
      name: meta.name || 'Session',
      createdAt: meta.createdAt || Date.now(),
      backend: 'claude',
      backendSessionId: meta.claudeSessionId || meta.backendSessionId || null,
      claudeSessionId: meta.claudeSessionId || null,
      agentToken: meta.agentToken || null,
      _accountId: meta.accountId || null,
      _authAtSpawn: meta.authAtSpawn || null,
      _permissionMode: meta.permissionMode || null,
      _effort: meta.effort || null,
      _modelOrigin: meta.modelOrigin || null, _effortOrigin: meta.effortOrigin || null, // B-6b6d: the spawn's model/effort ORIGIN survives a restart (else the panel's honest row degrades to a guess)
      _outputStyle: meta.outputStyle || null, // 2.369.58: the chip must not report "default" for a session really running a style
      _modelLocked: !!meta.modelLocked,
      _lockedModel: meta.lockedModel || null,
      _initialGroupId: meta.taskId || null,
      _remotePort: rport,
      sockName, socketPath, buffer: '',
    };
    session._normalizer = createMessageManager('claude', id);
    session._normEpoch = Date.now();
    session._normalizer.onOp((op) => broadcastToSession(session, id, { type: 'msg', sessionId: id, ...op }));
    activeSessions.set(id, session);
    session._webuiId = id; // per-session pool link key (plan C) — the id the session is registered under
    session._spawnModel = meta.spawnModel || null; session._pickedModel = meta.pickedModel || null; session._pickedModelAt = meta.pickedModelAt || 0; // plan C model ladder survives restarts
    session._msgReachability = meta.msgReachability || null; // Channels v1 per-session reach override survives restarts
    setupSessionPty(session, id, ptyProc);
    writeSessionMeta(sockName, { ...meta, orphanedAt: undefined, readoptedAt: Date.now(), webuiSessionId: id, mode: 'chat' });
    try { fs.unlinkSync(path.join(META_DIR, f)); } catch { }
    adopted++;
    console.log(`[readopt] re-adopted orphan keeper session ${meta.keeperSid} (${(meta.claudeSessionId || '').slice(0, 8)}) on ${h.name || meta.host} → ${id}${rport ? ` (tools tunnel :${rport} revived)` : ''}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  if (adopted) { refreshWebuiPids(); broadcastActiveSessions(); }
}

  return { migrateLegacyHomeProjects, restoreSessions, restoreAgentdPipeSessions,
    readoptOrphanKeeperSessions };
}
module.exports = { create };
