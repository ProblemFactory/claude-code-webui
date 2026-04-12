/**
 * Session API routes — discovery, active list, message history, subagent messages, kill.
 * Lock-first discovery algorithm + JSONL parsing for chat history.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const router = express.Router();

const {
  SESSIONS_DIR, isPidAlive, cwdToProjectDir, recoverCwdFromProjDir,
  getTmuxPaneMap, findTmuxTarget, isProcessClaude,
  extractSessionMeta, SessionMessages,
} = require('../session-store');
const { MessageManager } = require('../message-manager');

/** Setup session routes. Requires ctx object with dependencies. */
function setup(ctx) {
  const { activeSessions, webuiPids, refreshWebuiPids, createSessionMessages, BUFFERS_DIR, PERMISSION_MODES, execFileSync } = ctx;

  // Get chat message history for a Claude session (JSONL + optional buffer)
  router.get('/api/session-messages', (req, res) => {
    const { claudeSessionId, cwd, offset, limit, search } = req.query;
    if (!claudeSessionId) return res.status(400).json({ error: 'claudeSessionId required' });

    // Use session's existing normalizer if available (cached); else build on-demand
    let session = null;
    for (const [, s] of activeSessions) {
      if (s.claudeSessionId === claudeSessionId) { session = s; break; }
    }
    let mm;
    if (session?._normalizer && session._normalizer.total > 0) {
      mm = session._normalizer;
    } else {
      const sm = createSessionMessages(session || { claudeSessionId, cwd: cwd || '', buffer: '' });
      mm = new MessageManager('api');
      mm.convertHistory(sm.raw());
    }

    if (req.query.turnmap) {
      res.json({ turns: mm.turnMap(), total: mm.total });
    } else if (search) {
      res.json({ matches: mm.search(search), total: mm.total });
    } else if (offset !== undefined || limit !== undefined) {
      const o = parseInt(offset) || 0;
      const l = parseInt(limit) || 50;
      res.json({ messages: mm.slice(o, l), total: mm.total });
    } else {
      res.json({ messages: mm.tail(50), total: mm.total });
    }
  });

  // Subagent messages for a given session + agentId
  router.get('/api/subagent-messages', (req, res) => {
    const { claudeSessionId, cwd, agentId } = req.query;
    if (!claudeSessionId || !agentId) return res.status(400).json({ error: 'claudeSessionId and agentId required' });
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    const projDir = cwdToProjectDir(cwd || '');
    // Try exact project dir, then scan all
    const candidates = [];
    if (cwd) candidates.push(path.join(projectsDir, projDir, claudeSessionId, 'subagents', `agent-${agentId}.jsonl`));
    try {
      for (const dir of fs.readdirSync(projectsDir)) {
        const fp = path.join(projectsDir, dir, claudeSessionId, 'subagents', `agent-${agentId}.jsonl`);
        if (!candidates.includes(fp)) candidates.push(fp);
      }
    } catch {}
    for (const filePath of candidates) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf-8');
        const rawMsgs = [];
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try { const msg = JSON.parse(trimmed); rawMsgs.push(msg); } catch {}
        }
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(filePath.replace('.jsonl', '.meta.json'), 'utf-8')); } catch {}
        const mm = new MessageManager(`sub-agent-${agentId}`);
        mm.convertHistory(rawMsgs);
        return res.json({ messages: mm.messages, total: mm.total, meta });
      } catch {}
    }
    res.json({ messages: [], total: 0, meta: {} });
  });

  router.post('/api/kill-pid', (req, res) => {
    const { pid } = req.body;
    if (!pid || typeof pid !== 'number') return res.status(400).json({ error: 'pid required' });
    try {
      if (!isProcessClaude(pid)) return res.status(400).json({ error: 'PID is not a claude process' });
      process.kill(pid, 'SIGTERM');
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/api/sessions', (req, res) => {
    try {
      const projectsDir = path.join(os.homedir(), '.claude', 'projects');

      // Step 0: Use cached webuiPids (updated on session create/kill/restore)

      // Step 1: Scan lock files + tmux panes -> build map of RUNNING sessions
      // Build webuiPid -> claudeSessionId map for precise JSONL matching
      const webuiPidToSessionId = new Map();
      for (const [id, s] of activeSessions) {
        if (s.claudeSessionId) {
          // Map childPid + its direct children (claude forks from node-pty spawn)
          if (s._childPid) {
            webuiPidToSessionId.set(s._childPid, s.claudeSessionId);
            try {
              const ch = execFileSync('pgrep', ['-P', String(s._childPid)], { encoding: 'utf-8', timeout: 2000 }).trim();
              for (const line of ch.split('\n')) { const p = parseInt(line.trim()); if (p) webuiPidToSessionId.set(p, s.claudeSessionId); }
            } catch {}
          }
        }
      }

      const paneMap = getTmuxPaneMap();
      const runningByProjDir = new Map(); // projDirName -> [{lock, tmuxTarget, assigned, claudeSessionId}]
      if (fs.existsSync(SESSIONS_DIR)) {
        for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
            if (!isPidAlive(data.pid)) continue;
            if (!isProcessClaude(data.pid)) continue;
            const projDirName = cwdToProjectDir(data.cwd);
            const tmuxTarget = findTmuxTarget(data.pid, paneMap);
            const claudeSessionId = webuiPidToSessionId.get(data.pid) || null;
            if (!runningByProjDir.has(projDirName)) runningByProjDir.set(projDirName, []);
            runningByProjDir.get(projDirName).push({ lock: data, tmuxTarget, assigned: false, claudeSessionId });
          } catch {}
        }
      }

      // Step 2: Scan JSONL files, match with running locks
      const sessions = [];
      if (fs.existsSync(projectsDir)) {
        for (const projDir of fs.readdirSync(projectsDir)) {
          const projPath = path.join(projectsDir, projDir);
          try { if (!fs.statSync(projPath).isDirectory()) continue; } catch { continue; }

          // Pre-fetch stats for sorting + mtime lookup
          const jsonls = fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
          const statMap = new Map();
          for (const f of jsonls) {
            try { statMap.set(f, fs.statSync(path.join(projPath, f)).mtimeMs); } catch { statMap.set(f, 0); }
          }
          // Sort by mtime desc so most recent JSONL gets the running lock
          jsonls.sort((a, b) => (statMap.get(b) || 0) - (statMap.get(a) || 0));

          // Check if there are running locks for this project dir
          const runningEntries = runningByProjDir.get(projDir) || [];

          for (const f of jsonls) {
            const sessionId = f.replace('.jsonl', '');
            const filePath = path.join(projPath, f);
            const mtime = statMap.get(f) || 0;

            const meta = extractSessionMeta(filePath);
            const firstRunning = runningEntries.find(e => !e.assigned);
            const cwd = (firstRunning?.lock.cwd) || meta.cwd || recoverCwdFromProjDir(projDir);

            // Match running lock to JSONL:
            // 1. If a lock has claudeSessionId (WebUI), only match to that exact JSONL
            // 2. Otherwise (tmux/external), match to most recent unassigned JSONL (sorted by mtime desc)
            let status = 'stopped', pid = null, tmuxTarget = null;
            const exactMatch = runningEntries.find(e => !e.assigned && e.claudeSessionId === sessionId);
            const fallbackMatch = runningEntries.find(e => !e.assigned && !e.claudeSessionId);
            const match = exactMatch || fallbackMatch;
            // Also check if any active webui session claims this claudeSessionId (covers race during resume)
            let isWebuiSession = false;
            if (match) isWebuiSession = webuiPids.has(match.lock.pid);
            if (!isWebuiSession) {
              for (const [, s] of activeSessions) {
                if (s.claudeSessionId === sessionId) { isWebuiSession = true; break; }
              }
            }
            if (match) {
              status = isWebuiSession ? 'live'
                : match.tmuxTarget ? 'tmux' : 'external';
              pid = match.lock.pid;
              tmuxTarget = match.tmuxTarget || null;
              match.assigned = true;
            }

            sessions.push({ sessionId, cwd, pid, startedAt: mtime, status, name: meta.name || '', tmuxTarget });
          }
        }
      }

      // Step 3: Running locks that didn't match any project dir (brand new, no JSONL yet)
      for (const [, entries] of runningByProjDir) {
        for (const entry of entries) {
          if (!entry.assigned) {
            sessions.push({
              sessionId: entry.lock.sessionId, cwd: entry.lock.cwd, pid: entry.lock.pid,
              startedAt: entry.lock.startedAt || Date.now(),
              status: (webuiPids.has(entry.lock.pid) || [...activeSessions.values()].some(s => s.claudeSessionId === entry.lock.sessionId)) ? 'live'
                : entry.tmuxTarget ? 'tmux' : 'external', name: '',
              tmuxTarget: entry.tmuxTarget || null,
            });
          }
        }
      }

      sessions.sort((a, b) => b.startedAt - a.startedAt);
      res.json({ sessions });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/api/active', (req, res) => {
    const sessions = [];
    for (const [id, s] of activeSessions) {
      sessions.push({ id, name: s.name, cwd: s.cwd, createdAt: s.createdAt, claudeSessionId: s.claudeSessionId || null, mode: s.mode || 'terminal' });
    }
    res.json({ sessions });
  });
}

module.exports = { router, setup };
