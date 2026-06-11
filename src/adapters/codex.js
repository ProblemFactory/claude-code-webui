/**
 * CodexAdapter — BackendAdapter implementation for Codex CLI.
 *
 * Terminal mode uses interactive `codex` under PTY/dtach.
 * Chat mode uses the dedicated app-server wrapper under dtach.
 */

const { BackendAdapter } = require('./base');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const CODEX_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'];

function pushCodexConfigOverride(args, key, value) {
  if (!Array.isArray(args) || !key || value === undefined || value === null || value === '') return;
  args.push('-c', `${key}=${JSON.stringify(String(value))}`);
}

function resolveCodexPermissionMode(mode = 'default', { sandboxSupported = true } = {}) {
  if (!sandboxSupported && mode !== 'yolo') {
    return {
      permissionMode: mode === 'read-only' ? 'default' : mode,
      requestedPermissionMode: mode,
      approvalPolicy: mode === 'safe-yolo' ? 'on-failure' : 'on-request',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
      degraded: true,
      degradedReason: 'codex-linux-sandbox executable not found',
    };
  }

  switch (mode) {
    case 'read-only':
      return {
        permissionMode: 'read-only',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        sandboxPolicy: { type: 'readOnly' },
      };
    case 'safe-yolo':
      return {
        permissionMode: 'safe-yolo',
        approvalPolicy: 'on-failure',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite' },
      };
    case 'yolo':
      return {
        permissionMode: 'yolo',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' },
      };
    default:
      return {
        permissionMode: 'default',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite' },
      };
  }
}

function _walkJsonlFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fp = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fp);
      } else if (entry.isFile() && fp.endsWith('.jsonl')) {
        files.push(fp);
      }
    }
  }
  return files;
}

function findCodexSessionJsonlPath(threadId) {
  if (!threadId) return null;
  for (const fp of _walkJsonlFiles(CODEX_SESSIONS_DIR)) {
    if (fp.endsWith(`${threadId}.jsonl`)) return fp;
  }
  return null;
}

// Bounded JSONL read: head (session_meta, early turn_context) + tail (recent
// conversation), line-aligned. Two reasons full reads are wrong for huge
// rollouts: (1) Node cannot create a string > ~512MB — readFileSync('utf-8')
// THROWS on a 541MB file and the swallowed error left attach with an empty
// history (blank chat window); (2) even below the limit, parsing hundreds of
// MB of JSON synchronously blocks the event loop for the whole server.
const JSONL_HEAD_BYTES = 2 * 1024 * 1024;
const JSONL_TAIL_BYTES = 32 * 1024 * 1024;
function readJsonlBounded(fp, opts = {}) {
  const stat = fs.statSync(fp);
  if (stat.size <= JSONL_HEAD_BYTES + JSONL_TAIL_BYTES) return fs.readFileSync(fp, 'utf-8');
  console.warn(`[jsonl] large session file ${path.basename(fp)} (${Math.round(stat.size / 1048576)}MB): loading first ${JSONL_HEAD_BYTES / 1048576}MB + last ${JSONL_TAIL_BYTES / 1048576}MB, middle elided`);
  const fd = fs.openSync(fp, 'r');
  try {
    const headBuf = Buffer.alloc(JSONL_HEAD_BYTES);
    const hn = fs.readSync(fd, headBuf, 0, JSONL_HEAD_BYTES, 0);
    let head = headBuf.toString('utf-8', 0, hn);
    head = head.slice(0, head.lastIndexOf('\n') + 1);
    const tailBuf = Buffer.alloc(JSONL_TAIL_BYTES);
    const tn = fs.readSync(fd, tailBuf, 0, JSONL_TAIL_BYTES, stat.size - JSONL_TAIL_BYTES);
    let tail = tailBuf.toString('utf-8', 0, tn);
    tail = tail.slice(tail.indexOf('\n') + 1); // drop the cut-off first line
    // Make the elision VISIBLE: insert a marker line at the seam so the chat
    // shows where (and roughly how much) history was skipped, instead of the
    // head silently jumping into the tail mid-conversation
    if (typeof opts.makeMarker === 'function') {
      const elidedBytes = stat.size - hn - tn;
      const loadedLines = ((head.match(/\n/g) || []).length) + ((tail.match(/\n/g) || []).length);
      const approxOmitted = loadedLines ? Math.round(elidedBytes / ((hn + tn) / loadedLines)) : 0;
      const marker = opts.makeMarker(elidedBytes, approxOmitted);
      if (marker) return head + marker + '\n' + tail;
    }
    return head + tail;
  } finally { fs.closeSync(fd); }
}

function elisionNoticeText(elidedBytes, approxOmitted) {
  const mb = Math.round(elidedBytes / 1048576);
  return `<system-reminder>Session history truncated for display: ~${approxOmitted} records (${mb}MB) in the middle of this conversation were not loaded — the file is too large. Showing the earliest ${JSONL_HEAD_BYTES / 1048576}MB and the most recent ${JSONL_TAIL_BYTES / 1048576}MB.</system-reminder>`;
}

// ── Byte-offset line index for seek-based lazy loading of huge JSONL files ──
// A full readFileSync is impossible (>512MB string) and a full normalize is
// expensive, but the MIDDLE of a big rollout is still seek-readable: build a
// line→byte-offset table ONCE (streaming, Buffer scan — never holds the whole
// file as a string), cache it by mtime+size, then read any line range by
// pread without touching the rest. This is how the WebUI lets you scroll into
// the elided middle that head+tail loading skips.
const _lineIndexCache = new Map(); // fp -> { mtimeMs, size, offsets, totalLines }
const LINE_INDEX_CHUNK = 16 * 1024 * 1024;

function getJsonlLineIndex(fp) {
  const stat = fs.statSync(fp);
  const hit = _lineIndexCache.get(fp);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  const offsets = [0]; // byte offset where each line STARTS; offsets[i] = start of line i
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.alloc(LINE_INDEX_CHUNK);
    let pos = 0;
    while (pos < stat.size) {
      const n = fs.readSync(fd, buf, 0, LINE_INDEX_CHUNK, pos);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) {
        if (buf[i] === 0x0a) offsets.push(pos + i + 1); // start of next line
      }
      pos += n;
    }
  } finally { fs.closeSync(fd); }
  // offsets now has one trailing entry == file end if the file ends with \n;
  // totalLines = number of line starts that actually begin a line (< size)
  while (offsets.length > 1 && offsets[offsets.length - 1] >= stat.size) offsets.pop();
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, offsets, totalLines: offsets.length };
  _lineIndexCache.set(fp, entry);
  if (_lineIndexCache.size > 32) _lineIndexCache.delete(_lineIndexCache.keys().next().value);
  return entry;
}

// Which line indices does the head+tail window cover? Lines [0, headEndLine)
// are in the head, [tailStartLine, totalLines) in the tail; the gap in between
// is what lazy loading fetches. Returns null when the file isn't elided.
function jsonlGapInfo(fp) {
  const stat = fs.statSync(fp);
  if (stat.size <= JSONL_HEAD_BYTES + JSONL_TAIL_BYTES) return null;
  const { offsets, totalLines } = getJsonlLineIndex(fp);
  const tailStartByte = stat.size - JSONL_TAIL_BYTES;
  // first line whose start is within the head budget is excluded once offset > head
  let headEndLine = 0;
  while (headEndLine < totalLines && offsets[headEndLine] < JSONL_HEAD_BYTES) headEndLine++;
  let tailStartLine = headEndLine;
  while (tailStartLine < totalLines && offsets[tailStartLine] < tailStartByte) tailStartLine++;
  return { headEndLine, tailStartLine, totalLines, gapRecords: Math.max(0, tailStartLine - headEndLine) };
}

// Read raw records for line range [startLine, endLine) by seeking to the
// indexed byte offsets — no full-file read, no string-limit risk.
function readJsonlLineRange(fp, startLine, endLine) {
  const { offsets, totalLines, size } = getJsonlLineIndex(fp);
  const s = Math.max(0, Math.min(startLine, totalLines));
  const e = Math.max(s, Math.min(endLine, totalLines));
  if (e <= s) return [];
  const startByte = offsets[s];
  const endByte = e < totalLines ? offsets[e] : size;
  const len = endByte - startByte;
  if (len <= 0) return [];
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, startByte);
    const text = buf.toString('utf-8', 0, n);
    const records = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { records.push(JSON.parse(trimmed)); } catch {}
    }
    return records;
  } finally { fs.closeSync(fd); }
}

// Tag the seam marker, then give it the timestamp of its preceding record so
// timestamp-based sorting (mergeCodexRecords) keeps it at the seam
function applyElisionTimestamp(messages) {
  for (let i = 0; i < messages.length; i++) {
    if (!messages[i].__webui_elision) continue;
    const neighbor = messages[i - 1] || messages[i + 1];
    if (neighbor?.timestamp) messages[i].timestamp = neighbor.timestamp;
    break;
  }
  return messages;
}

function parseCodexSessionJsonl(threadId) {
  const fp = findCodexSessionJsonlPath(threadId);
  if (!fp) return [];
  const messages = [];
  try {
    const content = readJsonlBounded(fp, {
      makeMarker: (bytes, approx) => JSON.stringify({
        __webui_elision: true,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: elisionNoticeText(bytes, approx) }] },
      }),
    });
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { messages.push(JSON.parse(trimmed)); } catch {}
    }
  } catch {}
  return applyElisionTimestamp(messages);
}

function formatCodexRoleLabel(role) {
  const value = String(role || '').trim();
  if (!value) return '';
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function normalizeCodexSource(source) {
  if (typeof source === 'string') {
    return {
      raw: source,
      sourceKind: source,
      agentKind: 'primary',
      agentRole: '',
      agentNickname: '',
      parentThreadId: null,
    };
  }

  const subAgent = source?.subAgent || source?.subagent || source?.sub_agent || null;
  const spawn = subAgent?.thread_spawn || subAgent?.threadSpawn || source?.thread_spawn || null;
  if (spawn) {
    return {
      raw: source,
      sourceKind: 'subagent',
      agentKind: 'subagent',
      agentRole: spawn.agent_role || '',
      agentNickname: spawn.agent_nickname || '',
      parentThreadId: spawn.parent_thread_id || null,
    };
  }

  if (subAgent === 'review') {
    return {
      raw: source,
      sourceKind: 'review',
      agentKind: 'review',
      agentRole: source?.agentRole || source?.agent_role || '',
      agentNickname: source?.agentNickname || source?.agent_nickname || '',
      parentThreadId: source?.parentThreadId || source?.parent_thread_id || null,
    };
  }

  const review = source?.review || source?.review_mode || null;
  if (review) {
    return {
      raw: source,
      sourceKind: 'review',
      agentKind: 'review',
      agentRole: review.agent_role || '',
      agentNickname: review.agent_nickname || '',
      parentThreadId: review.parent_thread_id || null,
    };
  }

  return {
    raw: source || null,
    sourceKind: source ? 'structured' : null,
    agentKind: 'primary',
    agentRole: source?.agentRole || source?.agent_role || '',
    agentNickname: source?.agentNickname || source?.agent_nickname || '',
    parentThreadId: source?.parentThreadId || source?.parent_thread_id || null,
  };
}

function deriveCodexSessionName(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const lowerValue = value.toLowerCase();
  const injectedBlockMarkers = [
    '# agents.md instructions for ',
    '<instructions>',
    '<environment_context>',
    '<permissions instructions>',
    '<apps_instructions>',
    '<skills_instructions>',
    '<plugins_instructions>',
    '### available skills',
    '### available plugins',
  ];
  if (injectedBlockMarkers.some((marker) => lowerValue.includes(marker))) return '';
  const instructionMarkers = new Set([
    '<INSTRUCTIONS>',
    '</INSTRUCTIONS>',
    '<environment_context>',
    '</environment_context>',
    '<permissions instructions>',
    '</permissions instructions>',
    '<apps_instructions>',
    '</apps_instructions>',
    '<skills_instructions>',
    '</skills_instructions>',
    '<collaboration_mode>',
    '</collaboration_mode>',
  ]);
  const ignoreLine = (line) => (
    !line
    || line.startsWith('# AGENTS.md instructions')
    || line.startsWith('<system>')
    || instructionMarkers.has(line)
    || /^<(environment_context|permissions instructions|apps_instructions|skills_instructions|plugins_instructions|collaboration_mode)/.test(line)
    || /^<\/(environment_context|permissions instructions|apps_instructions|skills_instructions|plugins_instructions|collaboration_mode)/.test(line)
    || /^## (JavaScript REPL|Skills|Plugins)\b/.test(line)
    || /^<\/?[A-Z_]+>$/.test(line)
  );
  const firstLine = value
    .split('\n')
    .map((line) => line.trim())
    .find((line) => !ignoreLine(line)) || '';
  return firstLine.slice(0, 120);
}

function deriveCodexReviewName(target, hint) {
  const type = String(target?.type || '').trim();
  if (!type) return 'Review';

  if (type === 'uncommittedChanges' || type === 'workingTree') {
    return 'Review: Working Tree';
  }
  if (type === 'baseBranch') {
    const branch = String(target.branch || target.baseBranch || target.base_branch || '').trim();
    return branch ? `Review: ${branch}`.slice(0, 120) : 'Review: Base Branch';
  }
  if (type === 'commit') {
    const sha = String(target.sha || target.commit || target.commitSha || '').trim();
    return sha ? `Review: ${sha.slice(0, 12)}` : 'Review: Commit';
  }
  if (type === 'custom') {
    const custom = deriveCodexSessionName(hint || target.instructions || '');
    return custom ? `Review: ${custom}`.slice(0, 120) : 'Review: Custom';
  }

  const fallback = deriveCodexSessionName(hint || target.instructions || '');
  return fallback ? `Review: ${fallback}`.slice(0, 120) : 'Review';
}

function deriveCodexAgentName(agentKind, agentRole, agentNickname) {
  const roleLabel = formatCodexRoleLabel(agentRole);
  const nick = String(agentNickname || '').trim();

  if (agentKind === 'review') return 'Review';
  if (agentKind === 'subagent') {
    if (nick && roleLabel) return `${nick} (${roleLabel})`.slice(0, 120);
    if (nick) return nick.slice(0, 120);
    if (roleLabel) return `Subagent: ${roleLabel}`.slice(0, 120);
    return 'Subagent';
  }

  if (nick && roleLabel) return `${nick} (${roleLabel})`.slice(0, 120);
  if (nick) return nick.slice(0, 120);
  if (roleLabel) return roleLabel.slice(0, 120);
  return '';
}

// mtime-keyed cache: listCodexThreads runs extractCodexThreadMeta on EVERY
// thread JSONL per /api/sessions poll (and per user-state normalization) —
// uncached this re-read+re-parsed the entire ~/.codex/sessions tree each time.
// Mirrors the Claude side's _sessionMetaCache.
const _threadMetaCache = new Map(); // filePath -> { mtimeMs, meta }
const THREAD_META_HEAD_BYTES = 262144; // session_meta + first user msg live at the head

function extractCodexThreadMeta(filePath) {
  let cachedStat = null;
  try {
    cachedStat = fs.statSync(filePath);
    const hit = _threadMetaCache.get(filePath);
    if (hit && hit.mtimeMs === cachedStat.mtimeMs) return hit.meta;
  } catch {}
  let threadId = '';
  let cwd = '';
  let name = '';
  let updatedAt = 0;
  let source = null;
  let sourceMeta = normalizeCodexSource(null);
  let forkedFromId = null;
  let forkedFromChain = null;
  let sessionAgentRole = '';
  let sessionAgentNickname = '';
  let reviewDetected = false;
  let reviewTarget = null;
  let reviewHint = '';
  let firstUserName = '';
  let scannedRecords = 0;
  let extractFailed = false;
  try {
    const stat = cachedStat || fs.statSync(filePath);
    updatedAt = stat.mtimeMs || 0;
    // Head read only — all meta-bearing records are at the start; reading
    // multi-MB session files whole just to break at record 200 wasted IO
    let head;
    if (stat.size > THREAD_META_HEAD_BYTES) {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(THREAD_META_HEAD_BYTES);
        const n = fs.readSync(fd, buf, 0, THREAD_META_HEAD_BYTES, 0);
        head = buf.toString('utf-8', 0, n);
        head = head.slice(0, head.lastIndexOf('\n') + 1); // drop the cut-off last line
      } finally { fs.closeSync(fd); }
    } else {
      head = fs.readFileSync(filePath, 'utf-8');
    }
    for (const line of head.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      scannedRecords++;
      let msg = null;
      try { msg = JSON.parse(trimmed); } catch { continue; }

      if (msg.type === 'session_meta') {
        if (!threadId) threadId = msg.payload?.id || '';
        cwd = msg.payload?.cwd || cwd;
        const explicitName = deriveCodexSessionName(
          msg.payload?.session_name
          || msg.payload?.sessionName
          || msg.payload?.name
          || msg.payload?.threadName
          || '',
        );
        if (explicitName) name = explicitName;
        forkedFromId = msg.payload?.forked_from_id || forkedFromId;
        if (Array.isArray(msg.payload?.forked_from)) forkedFromChain = msg.payload.forked_from;
        if (!source) {
          source = msg.payload?.source || null;
          sourceMeta = normalizeCodexSource(source);
        }
        sessionAgentRole = msg.payload?.agent_role || msg.payload?.agentRole || sessionAgentRole;
        sessionAgentNickname = msg.payload?.agent_nickname || msg.payload?.agentNickname || sessionAgentNickname;
        continue;
      }

      if (msg.type === 'event_msg') {
        const eventType = msg.payload?.type || '';
        if (eventType === 'entered_review_mode') {
          reviewDetected = true;
          reviewTarget = msg.payload?.target || reviewTarget;
          reviewHint = msg.payload?.user_facing_hint || reviewHint;
        }
        if (eventType === 'review_started' && !reviewTarget) {
          reviewTarget = msg.payload?.target || reviewTarget;
        }
      }

      if (msg.type === 'response_item' && msg.payload?.type === 'enteredReviewMode') {
        reviewDetected = true;
        reviewTarget = msg.payload?.target || reviewTarget;
        reviewHint = msg.payload?.userFacingHint || msg.payload?.user_facing_hint || reviewHint;
      }

      if (!firstUserName && msg.type === 'response_item' && msg.payload?.type === 'message' && msg.payload?.role === 'user') {
        const content = msg.payload?.content || [];
        const firstText = content
          .filter((item) => item.type === 'input_text')
          .map((item) => item.text || '')
          .find((text) => deriveCodexSessionName(text)) || '';
        const nextName = deriveCodexSessionName(firstText);
        if (nextName) firstUserName = nextName;
      }

      if (scannedRecords >= 200 && threadId && cwd && (firstUserName || reviewDetected || sourceMeta.agentKind !== 'primary')) {
        break;
      }
    }
  } catch { extractFailed = true; }

  if (!sourceMeta.agentRole && sessionAgentRole) sourceMeta.agentRole = sessionAgentRole;
  if (!sourceMeta.agentNickname && sessionAgentNickname) sourceMeta.agentNickname = sessionAgentNickname;
  if (!sourceMeta.parentThreadId && forkedFromId && sourceMeta.agentKind !== 'primary') {
    sourceMeta.parentThreadId = forkedFromId;
  }

  if (reviewDetected || sourceMeta.agentKind === 'review') {
    sourceMeta = {
      ...sourceMeta,
      sourceKind: 'review',
      agentKind: 'review',
      parentThreadId: sourceMeta.parentThreadId || forkedFromId || null,
    };
    name = deriveCodexReviewName(reviewTarget, reviewHint || firstUserName);
  } else if (sourceMeta.agentKind === 'subagent') {
    name = deriveCodexAgentName(sourceMeta.agentKind, sourceMeta.agentRole, sourceMeta.agentNickname) || firstUserName;
  } else if (!name) {
    name = firstUserName || deriveCodexAgentName(sourceMeta.agentKind, sourceMeta.agentRole, sourceMeta.agentNickname);
  }

  const meta = {
    threadId,
    cwd,
    name,
    updatedAt,
    source,
    sourceKind: sourceMeta.sourceKind,
    agentKind: sourceMeta.agentKind,
    agentRole: sourceMeta.agentRole,
    agentNickname: sourceMeta.agentNickname,
    parentThreadId: sourceMeta.parentThreadId,
    forkedFrom: forkedFromChain || [],
  };
  // NEVER cache a failed extraction: a transient IO error (EMFILE under fd
  // pressure, mid-write race) would otherwise be cached keyed by the file's
  // current mtime — and if the session never writes again (terminated), the
  // empty threadId is cached FOREVER and the thread silently vanishes from
  // discovery until a server restart.
  if (cachedStat && !extractFailed) {
    _threadMetaCache.set(filePath, { mtimeMs: cachedStat.mtimeMs, meta });
    // Bounded: evict oldest entries past 2000 files
    if (_threadMetaCache.size > 2000) {
      const firstKey = _threadMetaCache.keys().next().value;
      _threadMetaCache.delete(firstKey);
    }
  }
  return meta;
}

class CodexAdapter extends BackendAdapter {
  constructor(config = {}) {
    super();
    this.config = config;
  }

  get name() { return 'codex'; }

  /**
   * Build session args for Codex terminal/chat modes.
   */
  buildSessionArgs(options) {
    const { cwd, model, effort, permissionMode, resumeId, fork = false, extraArgs = [], mode = 'terminal', initialPrompt = '' } = options;
    const resolvedPermission = resolveCodexPermissionMode(permissionMode, {
      sandboxSupported: this.config.codexSandboxSupported !== false,
    });

    if (mode === 'chat') {
      return {
        cmd: this.config.codexCmd || 'codex',
        args: ['app-server', ...extraArgs],
        wrapper: this.config.chatWrapper,
        cwd: cwd || os.homedir(),
        mode,
        env: {
          CODEX_WEBUI_MODEL: model || '',
          CODEX_WEBUI_EFFORT: effort || '',
          CODEX_WEBUI_RESUME_ID: resumeId || '',
          CODEX_WEBUI_FORK: fork ? '1' : '',
          CODEX_WEBUI_PERMISSION_MODE: resolvedPermission.permissionMode,
          CODEX_WEBUI_REQUESTED_PERMISSION_MODE: resolvedPermission.requestedPermissionMode || '',
          CODEX_WEBUI_PERMISSION_FALLBACK: resolvedPermission.degradedReason || '',
          CODEX_WEBUI_APPROVAL_POLICY: resolvedPermission.approvalPolicy,
          CODEX_WEBUI_SANDBOX: resolvedPermission.sandbox,
          CODEX_WEBUI_CWD: cwd || os.homedir(),
          CODEX_WEBUI_SESSION_NAME: options.sessionName || '',
        },
        permission: resolvedPermission,
      };
    }

    const commonArgs = [];
    if (model) commonArgs.push('--model', model);
    pushCodexConfigOverride(commonArgs, 'model_reasoning_effort', effort);
    if (resolvedPermission.approvalPolicy) commonArgs.push('--ask-for-approval', resolvedPermission.approvalPolicy);
    if (resolvedPermission.sandbox) commonArgs.push('--sandbox', resolvedPermission.sandbox);
    if (extraArgs.length) commonArgs.push(...extraArgs);

    const args = resumeId
      ? ['resume', ...commonArgs, resumeId]
      : [...commonArgs];

    if (initialPrompt) args.push(initialPrompt);

    return {
      cmd: this.config.codexCmd || 'codex',
      args,
      wrapper: this.config.ptyWrapper,
      cwd: cwd || os.homedir(),
      mode,
      permission: resolvedPermission,
    };
  }

  // ── Protocol formatting (called by ws-handler) ──

  formatChatInput(text, msgId) {
    const stdinPayload = JSON.stringify({ type: 'chat-input', text, msgId });
    const userMsg = CodexAdapter._buildUserPreview(text, msgId);
    return { stdinPayload, userMsg };
  }

  formatInterrupt() {
    return JSON.stringify({ type: 'interrupt' });
  }

  postInterrupt() {} // no SIGINT fallback needed

  formatPermissionResponse(data) {
    // requestUserInput answers arrive from the unified AskUserQuestion UI as
    // toolInput.answers (same shape as Claude); the wrapper expects them in
    // responseData.{decision,answers} — translate here so running wrappers
    // (which persist inside dtach across server restarts) need no change.
    let responseData = data.responseData || null;
    if (!responseData && data.toolInput?.answers) {
      responseData = {
        decision: data.approved ? 'accept' : (data.abort ? 'cancel' : 'decline'),
        answers: data.toolInput.answers,
      };
    }
    return JSON.stringify({
      type: 'permission-response',
      requestId: data.requestId,
      approved: !!data.approved,
      alwaysAllow: Array.isArray(data.permissionUpdates) && data.permissionUpdates.length > 0,
      abort: !!data.abort,
      responseData,
    });
  }

  formatSetPermissionMode(mode) {
    return JSON.stringify({ type: 'set-permission-mode', mode });
  }

  /** Build a preview user message for buffer before JSONL arrives */
  static _buildUserPreview(rawText, msgId) {
    let text = typeof rawText === 'string' ? rawText : '';
    const attachments = [];
    try {
      const parsed = JSON.parse(text);
      if (parsed?.type === 'user' && parsed.message) {
        text = '';
        for (const block of parsed.message.content || []) {
          if (block.type === 'text' && block.text) text = block.text;
          if (block.type === 'image' && block.source?.data) {
            attachments.push({ type: 'input_image', image_url: `data:${block.source.media_type || 'image/png'};base64,${block.source.data}` });
          }
        }
      }
    } catch {}
    const content = [
      ...attachments.map(a => ({ type: 'input_image', image_url: a.image_url })),
      ...(text ? [{ type: 'input_text', text }] : []),
    ];
    if (!content.length) return null;
    return { timestamp: new Date().toISOString(), type: 'response_item', _fromWebui: true, payload: { type: 'message', role: 'user', webui_msg_id: msgId || '', content } };
  }
}

module.exports = {
  CODEX_PERMISSION_MODES,
  CODEX_SESSIONS_DIR,
  CodexAdapter,
  findCodexSessionJsonlPath,
  normalizeCodexSource,
  parseCodexSessionJsonl,
  extractCodexThreadMeta,
  readJsonlBounded,
  elisionNoticeText,
  applyElisionTimestamp,
  getJsonlLineIndex,
  jsonlGapInfo,
  readJsonlLineRange,
  resolveCodexPermissionMode,
};
