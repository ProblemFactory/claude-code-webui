const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const {
  CODEX_SESSIONS_DIR,
  extractCodexThreadMeta,
  findCodexSessionJsonlPath,
  parseCodexSessionJsonl,
} = require('./adapters/codex');

function getCodexHistorySessionId(session) {
  return session?.backendSessionId || session?.claudeSessionId || null;
}

function getSessionKey(session = {}) {
  const backend = session.backend || 'claude';
  const backendSessionId = session.backendSessionId || session.sessionId || session.claudeSessionId || null;
  return backendSessionId ? `${backend}:${backendSessionId}` : '';
}

function parseBufferRecords(buffer) {
  const records = [];
  for (const line of String(buffer || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { records.push(JSON.parse(trimmed)); } catch {}
  }
  return records;
}

function extractThreadIdFromJsonlPath(filePath) {
  const match = String(filePath || '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : null;
}

function isCodexCommandLine(cmdline = '') {
  const value = String(cmdline || '');
  return (
    /(^|\0|[\/\s])codex(\0|\s|$)/.test(value)
    || value.includes('/@openai/codex/')
    || value.includes('/codex-linux-')
  );
}

function listOpenCodexThreadIdsFromProc() {
  const openThreadIds = new Set();
  let procEntries = [];
  try {
    procEntries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch {
    return openThreadIds;
  }

  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = entry.name;

    let cmdline = '';
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    } catch {
      continue;
    }
    if (!isCodexCommandLine(cmdline)) continue;

    let fds = [];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }

    for (const fd of fds) {
      let target = '';
      try {
        target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (!target.startsWith(CODEX_SESSIONS_DIR) || !target.endsWith('.jsonl')) continue;
      const threadId = extractThreadIdFromJsonlPath(target);
      if (threadId) openThreadIds.add(threadId);
    }
  }

  return openThreadIds;
}

function listOpenCodexThreadIdsFromLsof() {
  const openThreadIds = new Set();
  try {
    const output = execFileSync('lsof', ['-Fn', '+D', CODEX_SESSIONS_DIR], {
      encoding: 'utf-8',
      timeout: 4000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of output.split('\n')) {
      if (!line.startsWith('n')) continue;
      const filePath = line.slice(1).trim();
      if (!filePath.endsWith('.jsonl')) continue;
      const threadId = extractThreadIdFromJsonlPath(filePath);
      if (threadId) openThreadIds.add(threadId);
    }
  } catch {}
  return openThreadIds;
}

function listOpenCodexThreadIds() {
  if (process.platform === 'linux') return listOpenCodexThreadIdsFromProc();
  return listOpenCodexThreadIdsFromLsof();
}

function sortRecords(records) {
  return records
    .map((record, idx) => ({ ...record, __idx: idx, __ts: Date.parse(record.timestamp || '') || 0 }))
    .sort((a, b) => (a.__ts - b.__ts) || (a.__idx - b.__idx));
}

function recordFingerprint(record, turnId) {
  if (!record || typeof record !== 'object') return null;
  if (record.type === 'session_meta') return `session_meta:${record.payload?.id || ''}`;
  if (record.type === 'turn_context') return `turn_context:${record.payload?.turn_id || record.payload?.turnId || ''}`;
  if (record.type === 'wrapper_meta') return `wrapper_meta:${record.payload?.threadId || ''}:${record.payload?.activeTurnId || ''}`;
  if (record.type === 'server_request') return `server_request:${record.payload?.id}`;
  if (record.type === 'server_request_resolved') return `server_request_resolved:${record.payload?.id}:${record.payload?.decision || ''}`;
  const payload = record.payload || {};
  if (record.type === 'response_item') {
    if (payload.type === 'message' && payload.role === 'user') {
      const webuiMsgId = payload.webui_msg_id || payload.webuiMsgId || payload.client_msg_id || payload.clientMsgId || '';
      if (webuiMsgId) return `${turnId}:response_item:user:${webuiMsgId}`;
    }
    const key = payload.call_id || payload.callId || payload.role || payload.type || 'item';
    return `${turnId}:response_item:${payload.type}:${key}:${JSON.stringify(payload)}`;
  }
  if (record.type === 'event_msg') {
    const key = payload.turn_id || payload.turnId || payload.call_id || payload.callId || payload.item_id || payload.itemId || payload.type || 'event';
    return `${turnId}:event_msg:${payload.type}:${key}:${JSON.stringify(payload)}`;
  }
  return null;
}

function mergeCodexRecords(historyRecords, liveRecords) {
  const merged = [];
  const seen = new Set();
  let currentTurnId = 'prelude';
  for (const record of sortRecords([...(historyRecords || []), ...(liveRecords || [])])) {
    if (record.type === 'turn_context') {
      currentTurnId = record.payload?.turn_id || record.payload?.turnId || currentTurnId;
    }
    const fp = recordFingerprint(record, currentTurnId);
    if (fp && seen.has(fp)) continue;
    if (fp) seen.add(fp);
    delete record.__idx;
    delete record.__ts;
    merged.push(record);
  }
  return merged;
}

class CodexSessionMessages {
  constructor(session, sessionId, { buffersDir } = {}) {
    this._session = session;
    this._sessionId = sessionId;
    this._buffersDir = buffersDir;
    this._all = null;
    this._wrapperMeta = undefined;
  }

  _ensureParsed() {
    if (this._all) return;
    const threadId = getCodexHistorySessionId(this._session);
    const history = threadId ? parseCodexSessionJsonl(threadId) : [];
    const live = parseBufferRecords(this._session?.buffer || '');
    this._all = mergeCodexRecords(history, live);
  }

  get total() { this._ensureParsed(); return this._all.length; }
  raw() { this._ensureParsed(); return this._all; }
  tail(n = 50) { this._ensureParsed(); return this._all.slice(-n); }
  slice(offset, limit) { this._ensureParsed(); return this._all.slice(offset, offset + limit); }

  get isStreaming() {
    const meta = this.wrapperMeta();
    return !!meta?.streaming;
  }

  wrapperMeta() {
    if (this._wrapperMeta !== undefined) return this._wrapperMeta;
    if (!this._buffersDir || !this._sessionId) {
      this._wrapperMeta = null;
      return this._wrapperMeta;
    }
    try {
      this._wrapperMeta = JSON.parse(fs.readFileSync(path.join(this._buffersDir, `${this._sessionId}.json`), 'utf-8'));
    } catch {
      this._wrapperMeta = null;
    }
    return this._wrapperMeta;
  }

  chatStatus() {
    this._ensureParsed();
    const status = {
      model: '',
      lastUsage: null,
      contextWindow: 0,
      total_cost_usd: 0,
      permissionMode: '',
      permissionModes: ['default', 'read-only', 'safe-yolo', 'yolo'],
      subagentMetas: [],
    };
    const meta = this.wrapperMeta();
    if (meta?.model) status.model = meta.model;
    if (meta?.permissionMode) status.permissionMode = meta.permissionMode;
    if (meta?.contextWindow) status.contextWindow = meta.contextWindow;
    if (meta?.subagentMetas) status.subagentMetas = meta.subagentMetas;

    for (const record of this._all) {
      if (record.type === 'session_meta' && !status.model) {
        status.model = record.payload?.model || '';
      } else if (record.type === 'turn_context') {
        if (record.payload?.model) status.model = record.payload.model;
        if (record.payload?.permissionMode) status.permissionMode = record.payload.permissionMode;
        if (record.payload?.approval_policy && !status.permissionMode) status.permissionMode = record.payload.approval_policy;
        if (record.payload?.model_context_window) status.contextWindow = record.payload.model_context_window;
      } else if (record.type === 'event_msg' && record.payload?.type === 'token_count') {
        const info = record.payload.info || {};
        const last = info.last_token_usage || info.lastTokenUsage || info.total_token_usage || null;
        if (last) {
          status.lastUsage = {
            input_tokens: last.input_tokens || last.inputTokens || 0,
            cache_read_input_tokens: last.cached_input_tokens || last.cache_read_input_tokens || last.cachedInputTokens || 0,
            cache_creation_input_tokens: last.cache_creation_input_tokens || last.cacheCreationInputTokens || 0,
          };
        }
        if (info.model_context_window || info.modelContextWindow) {
          status.contextWindow = info.model_context_window || info.modelContextWindow;
        }
      }
    }

    return status.model || status.lastUsage || status.permissionMode ? status : null;
  }

  taskState() {
    const meta = this.wrapperMeta();
    const tasks = {};
    for (const [taskId, taskInfo] of Object.entries(meta?.tasks || {})) {
      if ((taskInfo?.type || '') !== 'agent') continue;
      if ((taskInfo?.status || '') !== 'running') continue;
      tasks[taskId] = taskInfo;
    }
    return {
      tasks,
      todos: [],
    };
  }
}

function listCodexThreads({ activeSessions } = {}) {
  const sessions = [];
  const seen = new Set();
  const activeByThreadId = new Map();
  const externallyOpenThreadIds = listOpenCodexThreadIds();
  for (const [id, session] of activeSessions || []) {
    if (session.backend !== 'codex') continue;
    const threadId = session.backendSessionId || session.claudeSessionId;
    if (!threadId) continue;
    activeByThreadId.set(threadId, { id, session });
  }

  const stack = [CODEX_SESSIONS_DIR];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fp = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fp);
        continue;
      }
      if (!entry.isFile() || !fp.endsWith('.jsonl')) continue;
      const meta = extractCodexThreadMeta(fp);
      if (!meta.threadId || seen.has(meta.threadId)) continue;
      seen.add(meta.threadId);
      const active = activeByThreadId.get(meta.threadId);
      const isExternal = !active && externallyOpenThreadIds.has(meta.threadId);
      sessions.push({
        backend: 'codex',
        backendSessionId: meta.threadId,
        sessionId: meta.threadId,
        sessionKey: getSessionKey({ backend: 'codex', backendSessionId: meta.threadId }),
        cwd: meta.cwd || '',
        startedAt: meta.updatedAt || Date.now(),
        status: active ? 'live' : (isExternal ? 'external' : 'stopped'),
        name: meta.name || meta.agentNickname || meta.agentRole || '',
        source: meta.source || null,
        sourceKind: meta.sourceKind || null,
        agentKind: meta.agentKind || 'primary',
        agentRole: meta.agentRole || '',
        agentNickname: meta.agentNickname || '',
        parentThreadId: meta.parentThreadId || null,
        webuiId: active?.id || null,
        webuiName: active?.session?.name || null,
        webuiMode: active?.session?.mode || null,
      });
    }
  }

  sessions.sort((a, b) => b.startedAt - a.startedAt);
  return sessions;
}

module.exports = {
  CODEX_SESSIONS_DIR,
  CodexSessionMessages,
  findCodexSessionJsonlPath,
  getCodexHistorySessionId,
  listCodexThreads,
  mergeCodexRecords,
  parseCodexSessionJsonl,
};
