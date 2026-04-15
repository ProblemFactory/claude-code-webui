/**
 * Session store — JSONL parsing, caching, SessionMessages class,
 * session discovery helpers (path recovery, tmux, PID checks).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

// ── Helpers ──

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cwdToProjectDir(cwd) {
  return cwd.replace(/[/._]/g, '-');
}

function recoverCwdFromProjDir(projDir) {
  const parts = projDir.replace(/^-/, '').split('-');
  let current = '/';
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue;
    let found = false;
    for (let j = parts.length; j > i; j--) {
      const segment = parts.slice(i, j).join('-');
      if (fs.existsSync(path.join(current, segment))) {
        current = path.join(current, segment); i = j - 1; found = true; break;
      }
      if (fs.existsSync(path.join(current, '.' + segment))) {
        current = path.join(current, '.' + segment); i = j - 1; found = true; break;
      }
      const underscored = parts.slice(i, j).join('_');
      if (underscored !== segment && fs.existsSync(path.join(current, underscored))) {
        current = path.join(current, underscored); i = j - 1; found = true; break;
      }
    }
    if (!found) {
      current = path.join(current, parts.slice(i).join('-'));
      break;
    }
  }
  return current;
}

function getTmuxPaneMap() {
  const map = new Map();
  try {
    const out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_pid}||#{session_name}:#{window_index}.#{pane_index}'], { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    for (const line of out.split('\n')) {
      const [pid, target] = line.split('||');
      if (pid && target) map.set(parseInt(pid), target);
    }
  } catch {}
  return map;
}

function findTmuxTarget(pid, paneMap) {
  if (paneMap.has(pid)) return paneMap.get(pid);
  try {
    const ppid = parseInt(execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf-8', timeout: 2000 }).trim());
    if (paneMap.has(ppid)) return paneMap.get(ppid);
  } catch {}
  return null;
}

function isProcessClaude(pid) {
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8', timeout: 2000 }).trim();
    return cmd === 'claude' || cmd.includes('claude');
  } catch { return false; }
}

// ── JSONL helpers ──

function isSubagentMessage(msg) { return !!(msg.parent_tool_use_id || msg.isSidechain); }

function isDisplayMessage(msg) {
  return msg.type === 'user' || msg.type === 'assistant' || msg.type === 'result' || (msg.type === 'system' && msg.subtype === 'init');
}

function findSessionJsonlPath(claudeSessionId, cwd) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const projDir = cwdToProjectDir(cwd || '');
  const candidates = [];
  if (cwd) candidates.push(path.join(projectsDir, projDir, claudeSessionId + '.jsonl'));
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const fp = path.join(projectsDir, dir, claudeSessionId + '.jsonl');
      if (!candidates.includes(fp)) candidates.push(fp);
    }
  } catch {}
  for (const fp of candidates) {
    try { if (fs.existsSync(fp)) return fp; } catch {}
  }
  return null;
}

// JSONL parse cache — stores ALL non-subagent messages (unfiltered)
const _jsonlCache = new Map();

function parseSessionJsonl(claudeSessionId, cwd) {
  const fp = findSessionJsonlPath(claudeSessionId, cwd);
  if (!fp) return [];
  try {
    const stat = fs.statSync(fp);
    const cached = _jsonlCache.get(claudeSessionId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.messages;

    const content = fs.readFileSync(fp, 'utf-8');
    const messages = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (!isSubagentMessage(msg)) messages.push(msg);
      } catch {}
    }
    _jsonlCache.set(claudeSessionId, { mtimeMs: stat.mtimeMs, size: stat.size, messages });
    return messages;
  } catch { return []; }
}

// Session metadata cache (cwd + first user message)
const _sessionMetaCache = new Map();

function extractSessionMeta(filePath) {
  try {
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    const cached = _sessionMetaCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
  } catch {}

  let cwd = '', name = '';
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(32768);
    const bytesRead = fs.readSync(fd, buf, 0, 32768, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf-8', 0, bytesRead).split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (!cwd && d.cwd) cwd = d.cwd;
        if (d.type === 'user' && !name) {
          const msg = d.message;
          if (msg?.content) {
            const content = Array.isArray(msg.content)
              ? (msg.content.find(c => c.type === 'text')?.text || '')
              : String(msg.content);
            name = content.split('\n')[0].substring(0, 80);
          }
        }
        if (cwd && name) break;
      } catch {}
    }
  } catch {}

  const meta = { cwd, name };
  try { _sessionMetaCache.set(filePath, { mtimeMs: fs.statSync(filePath).mtimeMs, meta }); } catch {}
  return meta;
}

function getSubagentMetas(claudeSessionId, cwd) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const projDir = cwdToProjectDir(cwd || '');
  const candidates = [];
  if (cwd) candidates.push(path.join(projectsDir, projDir, claudeSessionId, 'subagents'));
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const fp = path.join(projectsDir, dir, claudeSessionId, 'subagents');
      if (!candidates.includes(fp)) candidates.push(fp);
    }
  } catch {}
  for (const subDir of candidates) {
    try {
      if (!fs.existsSync(subDir)) continue;
      const metas = [];
      for (const f of fs.readdirSync(subDir)) {
        if (!f.endsWith('.meta.json')) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(subDir, f), 'utf-8'));
          const agentId = f.replace('agent-', '').replace('.meta.json', '');
          metas.push({ agentId, description: meta.description || '', agentType: meta.agentType || '' });
        } catch {}
      }
      return metas;
    } catch {}
  }
  return [];
}

function getHistorySessionId(session) {
  return session?.backendSessionId || session?.claudeSessionId || null;
}

// ── SessionMessages class ──

class SessionMessages {
  constructor(session, sessionId, { buffersDir, permissionModes } = {}) {
    this._session = session;
    this._sessionId = sessionId;
    this._buffersDir = buffersDir;
    this._permissionModes = permissionModes || [];
    this._all = null;
    this._display = null;
    this._pendingPerms = null;
    this._wrapperMeta = undefined;
    this._taskState = undefined;
  }

  _ensureParsed() {
    if (this._all) return;
    const session = this._session;
    const historySessionId = getHistorySessionId(session);
    const jsonl = historySessionId ? parseSessionJsonl(historySessionId, session.cwd) : [];
    const uuids = new Set();
    for (const m of jsonl) { if (m.uuid) uuids.add(m.uuid); }

    this._pendingPerms = {};
    const live = [];
    for (const line of (session.buffer || '').split('\n')) {
      const trimmed = line.replace(/\r/g, '').trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.type === 'control_request' && msg.request?.tool_use_id) { this._pendingPerms[msg.request.tool_use_id] = msg; continue; }
        if (isSubagentMessage(msg)) continue;
        if (msg.uuid && uuids.has(msg.uuid)) continue;
        if (msg._fromWebui && msg.timestamp) {
          if (jsonl.some(m => m.type === 'user' && m.timestamp >= msg.timestamp)) continue;
        }
        live.push(msg);
      } catch {}
    }
    this._all = live.length ? [...jsonl, ...live] : jsonl;
    this._display = this._all.filter(isDisplayMessage);
  }

  get total() { this._ensureParsed(); return this._display.length; }
  get pendingPermissions() { this._ensureParsed(); return this._pendingPerms; }

  get isStreaming() {
    const wMeta = this.wrapperMeta();
    if (wMeta?.streaming != null) return wMeta.streaming;
    return false;
  }

  tail(n = 50) { this._ensureParsed(); return this._display.slice(-n); }
  slice(offset, limit) { this._ensureParsed(); return this._display.slice(offset, offset + limit); }
  all() { this._ensureParsed(); return this._display; }
  raw() { this._ensureParsed(); return this._all; }

  search(query) {
    this._ensureParsed();
    const q = query.toLowerCase();
    const matches = [];
    for (let i = 0; i < this._display.length; i++) {
      const m = this._display[i];
      const c = m.message?.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) text = c.map(b => b.text || '').join(' ');
      if (text.toLowerCase().includes(q)) matches.push({ index: i, type: m.type, preview: text.substring(0, 120) });
    }
    return matches;
  }

  chatStatus() {
    this._ensureParsed();
    const msgs = this._all;
    let lastUsage = null, model = null, contextWindow = 0, totalCost = 0, slashCommands = null, permissionMode = null;
    for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 200); i--) {
      const m = msgs[i];
      if (!lastUsage && m.type === 'assistant' && m.message?.usage) lastUsage = m.message.usage;
      if (!model && m.type === 'result' && m.modelUsage) { model = Object.keys(m.modelUsage)[0]; contextWindow = Object.values(m.modelUsage)[0]?.contextWindow || 0; }
      if (lastUsage && model) break;
    }
    for (let i = 0; i < Math.min(msgs.length, 5); i++) {
      const m = msgs[i];
      if (m.type === 'system' && m.subtype === 'init') {
        if (m.slash_commands) slashCommands = m.slash_commands;
        if (!model && m.model) model = m.model;
        if (m.permissionMode) permissionMode = m.permissionMode;
        break;
      }
    }
    for (const m of msgs) { if (m.type === 'result' && m.total_cost_usd) totalCost += m.total_cost_usd; }
    if (!lastUsage && !model) return null;
    return {
      model, lastUsage, contextWindow, total_cost_usd: totalCost, slashCommands, permissionMode,
      permissionModes: this._permissionModes,
      subagentMetas: getSubagentMetas(getHistorySessionId(this._session), this._session.cwd),
    };
  }

  activePendingPermissions() {
    this._ensureParsed();
    const resolved = new Set();
    for (const m of this._all.slice(-100)) {
      if (m.type !== 'user') continue;
      const c = m.message?.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) { if (b.type === 'tool_result' && b.tool_use_id) resolved.add(b.tool_use_id); }
    }
    const result = {};
    for (const [id, cr] of Object.entries(this._pendingPerms)) {
      if (!resolved.has(id)) result[id] = cr;
    }
    return result;
  }

  wrapperMeta() {
    if (this._wrapperMeta === undefined) {
      if (this._sessionId && this._buffersDir) {
        try { this._wrapperMeta = JSON.parse(fs.readFileSync(path.join(this._buffersDir, this._sessionId + '.json'), 'utf-8')); }
        catch { this._wrapperMeta = null; }
      } else {
        this._wrapperMeta = null;
      }
    }
    return this._wrapperMeta;
  }

  taskState() {
    if (this._taskState !== undefined) return this._taskState;
    const wMeta = this.wrapperMeta();
    if (wMeta?.tasks || wMeta?.todos) {
      this._taskState = { tasks: wMeta.tasks || {}, todos: wMeta.todos || [] };
      return this._taskState;
    }
    this._ensureParsed();
    const tasks = {};
    const todos = [];
    for (const msg of this._all) {
      if (msg.type === 'system' && msg.tool_use_id) {
        if (msg.subtype === 'task_started') {
          tasks[msg.tool_use_id] = { id: msg.task_id, type: msg.task_type === 'local_agent' ? 'agent' : 'command', description: msg.description || '', status: 'running' };
        } else if (msg.subtype === 'task_progress' && tasks[msg.tool_use_id]) {
          if (msg.description) tasks[msg.tool_use_id].description = msg.description;
          if (msg.last_tool_name) tasks[msg.tool_use_id].lastTool = msg.last_tool_name;
        } else if (msg.subtype === 'task_notification' && tasks[msg.tool_use_id]) {
          tasks[msg.tool_use_id].status = 'completed';
        }
      }
      if (msg.type === 'assistant' && msg.message?.content) {
        const blocks = Array.isArray(msg.message.content) ? msg.message.content : [];
        for (const b of blocks) {
          if (b.type === 'tool_use' && b.name === 'TodoWrite' && b.input?.todos) {
            todos.length = 0;
            todos.push(...b.input.todos);
          }
        }
      }
    }
    this._taskState = { tasks, todos };
    return this._taskState;
  }
}

module.exports = {
  SESSIONS_DIR,
  isPidAlive,
  cwdToProjectDir,
  recoverCwdFromProjDir,
  getTmuxPaneMap,
  findTmuxTarget,
  isProcessClaude,
  isSubagentMessage,
  isDisplayMessage,
  findSessionJsonlPath,
  parseSessionJsonl,
  extractSessionMeta,
  getSubagentMetas,
  getHistorySessionId,
  SessionMessages,
};
