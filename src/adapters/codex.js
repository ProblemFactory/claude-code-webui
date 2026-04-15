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

function parseCodexSessionJsonl(threadId) {
  const fp = findCodexSessionJsonlPath(threadId);
  if (!fp) return [];
  const messages = [];
  try {
    for (const line of fs.readFileSync(fp, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { messages.push(JSON.parse(trimmed)); } catch {}
    }
  } catch {}
  return messages;
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

function extractCodexThreadMeta(filePath) {
  let threadId = '';
  let cwd = '';
  let name = '';
  let updatedAt = 0;
  let source = null;
  let sourceMeta = normalizeCodexSource(null);
  let forkedFromId = null;
  let sessionAgentRole = '';
  let sessionAgentNickname = '';
  let reviewDetected = false;
  let reviewTarget = null;
  let reviewHint = '';
  let firstUserName = '';
  let scannedRecords = 0;
  try {
    const stat = fs.statSync(filePath);
    updatedAt = stat.mtimeMs || 0;
    for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
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
  } catch {}

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

  return {
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
  };
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
    const { cwd, model, effort, permissionMode, resumeId, extraArgs = [], mode = 'terminal', initialPrompt = '' } = options;
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

  parseHistory(threadId) {
    if (!threadId) return [];
    return parseCodexSessionJsonl(threadId);
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
  resolveCodexPermissionMode,
};
