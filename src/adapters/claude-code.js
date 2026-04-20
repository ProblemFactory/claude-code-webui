/**
 * ClaudeCodeAdapter — BackendAdapter implementation for Claude Code CLI.
 *
 * Manages sessions via dtach for persistence. Chat mode uses chat-wrapper.js
 * (stream-json), terminal mode uses pty-wrapper.js (raw PTY).
 *
 * This adapter encapsulates all Claude-Code-specific knowledge:
 * - CLI flags (--output-format, --input-format, --verbose, --permission-prompt-tool)
 * - JSONL file locations (~/.claude/projects/<projDir>/<sessionId>.jsonl)
 * - Lock file format for session discovery
 * - control_request/control_response protocol for permissions
 * - stream-json message format
 */

const { BackendAdapter, SessionHandle } = require('./base');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');

class ClaudeCodeAdapter extends BackendAdapter {
  /**
   * @param {object} config - { claudeCmd, nodeCmd, dtachCmd, envCmd, editorCmd,
   *                            ptyWrapper, chatWrapper, buffersDir, port }
   */
  constructor(config) {
    super();
    this.config = config;
  }

  get name() { return 'claude-code'; }

  /**
   * Create a Claude Code session.
   * Spawns dtach with the appropriate wrapper (chat or terminal).
   *
   * Note: actual PTY spawning is handled by the server's existing code.
   * This adapter provides the command line arguments and session config.
   */
  buildSessionArgs(options) {
    const { cwd, model, permissionMode, resumeId, sessionName, effort, extraArgs = [], mode = 'chat' } = options;
    const args = [];

    if (resumeId) {
      args.push('--resume', resumeId);
    }
    if (sessionName && this.config.supportsName) args.push('--name', sessionName);
    if (model) args.push('--model', model);
    if (permissionMode) args.push('--permission-mode', permissionMode);
    if (effort) args.push('--effort', effort);
    if (extraArgs.length) args.push(...extraArgs);

    return {
      cmd: this.config.claudeCmd,
      args,
      wrapper: mode === 'chat' ? this.config.chatWrapper : this.config.ptyWrapper,
      cwd: cwd || os.homedir(),
      mode,
    };
  }

  /**
   * Parse JSONL history for a Claude session.
   * Returns raw Claude messages (not normalized).
   */
  parseHistory(claudeSessionId, cwd) {
    if (!claudeSessionId) return [];
    const fp = this._findJsonlPath(claudeSessionId, cwd);
    if (!fp) return [];
    try {
      const content = fs.readFileSync(fp, 'utf-8');
      const messages = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          // Skip subagent messages (handled separately)
          if (msg.parent_tool_use_id || msg.isSidechain) continue;
          messages.push(msg);
        } catch {}
      }
      return messages;
    } catch { return []; }
  }

  /**
   * Find JSONL file path for a session.
   */
  _findJsonlPath(claudeSessionId, cwd) {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    const projDir = this._cwdToProjectDir(cwd || '');
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

  /** Encode CWD to Claude's project directory name */
  _cwdToProjectDir(cwd) {
    return cwd.replace(/[/._]/g, '-');
  }

  // ── Protocol formatting (called by ws-handler) ──

  formatChatInput(text, msgId) {
    let stdinPayload, userMsg;
    let parsed = null;
    try { parsed = JSON.parse(text); if (!(parsed.type === 'user' && parsed.message)) parsed = null; } catch {}
    if (parsed) {
      stdinPayload = text;
      userMsg = { ...parsed, msgId, timestamp: new Date().toISOString() };
    } else {
      stdinPayload = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
      userMsg = { type: 'user', message: { role: 'user', content: text }, msgId, timestamp: new Date().toISOString() };
    }
    userMsg._fromWebui = true;
    return { stdinPayload, userMsg };
  }

  formatInterrupt() {
    return JSON.stringify(ClaudeCodeAdapter.buildInterruptRequest());
  }

  postInterrupt(session, sessionId) {
    // Delayed SIGINT fallback: if Claude is still streaming 2s after the
    // control_request, send SIGINT as last resort. In recent Claude Code
    // versions SIGINT exits the whole process (killing the session), so we
    // avoid it unless the protocol-level interrupt actually failed.
    // Historical context: bugs #17466, #3455 — may be fixed now.
    if (!session._childPid) return;
    if (session._interruptTimer) clearTimeout(session._interruptTimer);
    session._interruptTimer = setTimeout(() => {
      session._interruptTimer = null;
      // Check if the control_request interrupt worked by reading wrapper meta
      try {
        const metaPath = path.join(this.config.buffersDir, sessionId + '.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (!meta.streaming) return; // Interrupt worked — no need for SIGINT
      } catch {}
      // Still streaming after 2s → force SIGINT
      try { process.kill(session._childPid, 'SIGINT'); } catch {}
    }, 2000);
  }

  formatPermissionResponse(data) {
    return JSON.stringify(ClaudeCodeAdapter.buildPermissionResponse(data.requestId, data.approved, data.toolInput, data.permissionUpdates));
  }

  formatSetPermissionMode(mode) {
    return JSON.stringify(ClaudeCodeAdapter.buildSetPermissionMode(mode));
  }

  buildUserPreview(text, msgId) { return null; } // handled inline by formatChatInput

  // ── Static helpers (kept for backward compat) ──

  static buildPermissionResponse(requestId, approved, toolInput, permissionUpdates) {
    const allowResponse = { behavior: 'allow', updatedInput: toolInput || {} };
    if (permissionUpdates?.length) allowResponse.permission_updates = permissionUpdates;
    return {
      type: 'control_response',
      response: approved
        ? { subtype: 'success', request_id: requestId, response: allowResponse }
        : { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: 'User denied this action' } },
    };
  }

  static buildInterruptRequest() {
    return {
      type: 'control_request',
      request_id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      request: { subtype: 'interrupt' },
    };
  }

  static buildSetPermissionMode(mode) {
    return {
      type: 'control_request',
      request_id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      request: { subtype: 'set_permission_mode', mode },
    };
  }
}

module.exports = { ClaudeCodeAdapter };
