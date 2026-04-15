/**
 * BackendAdapter — abstract interface for AI coding agent backends.
 *
 * Each adapter translates between its native protocol and the WebUI's
 * normalized message system. The WebUI doesn't know (or care) whether
 * it's talking to Claude Code, Codex, Gemini CLI, or anything else.
 *
 * Adapters are responsible for:
 * - Session lifecycle (create, attach, resume, kill)
 * - Message transport (send input, receive output)
 * - Permission handling
 * - Session persistence (dtach, tmux, etc.)
 */

const EventEmitter = require('events');

class BackendAdapter {
  /** Human-readable backend name */
  get name() { return 'base'; }

  /**
   * Create a new session.
   * @param {object} options - { cwd, model, permissionMode, resumeId, name, extraArgs }
   * @returns {SessionHandle}
   */
  async createSession(options) { throw new Error('not implemented'); }

  /**
   * Attach to an existing session.
   * @param {string} sessionId - WebUI session ID
   * @param {object} sessionMeta - { socketPath, cwd, backend, backendSessionId, ... }
   * @returns {SessionHandle}
   */
  async attachSession(sessionId, sessionMeta) { throw new Error('not implemented'); }

  /**
   * Discover running sessions (for sidebar).
   * @returns {Array<{ pid, sessionId, cwd, status }>}
   */
  async discoverSessions() { return []; }

  /**
   * Parse historical messages from this backend's storage.
   * Returns raw messages in the backend's format (normalizer converts them).
   * @param {string} backendSessionId
   * @param {string} cwd
   * @returns {object[]} Raw messages
   */
  parseHistory(backendSessionId, cwd) { return []; }
}

/**
 * SessionHandle — represents a running session.
 *
 * The WebUI server holds a reference to this. It calls methods to send
 * input and receives events when the backend produces output.
 *
 * Events:
 *   'message' (rawMsg) — raw message from backend (fed into MessageNormalizer)
 *   'exit' (exitCode) — session ended
 *   'error' (Error) — session error
 */
class SessionHandle extends EventEmitter {
  constructor() {
    super();
    this.mode = 'chat'; // 'chat' or 'terminal'
  }

  /** Send user text input */
  async sendMessage(text, attachments = []) { throw new Error('not implemented'); }

  /** Respond to a permission request */
  async respondPermission(requestId, approved, options = {}) { throw new Error('not implemented'); }

  /** Set permission mode */
  async setPermissionMode(mode) { throw new Error('not implemented'); }

  /** Interrupt current operation */
  async interrupt() { throw new Error('not implemented'); }

  /** Kill/terminate the session */
  async kill() { throw new Error('not implemented'); }

  /** Resize terminal (cols, rows) */
  async resize(cols, rows) {}

  /** Write raw data to PTY (for terminal mode) */
  async writeRaw(data) {}

  /** Get child process PID (for process tracking) */
  get childPid() { return null; }

  /** Get the raw PTY buffer (for terminal mode attach) */
  get buffer() { return ''; }
}

/**
 * Protocol formatting methods — called by ws-handler to build
 * backend-specific JSON payloads. Eliminates if/else branching.
 */
BackendAdapter.prototype.formatChatInput = function(text, msgId) { throw new Error('not implemented'); };
BackendAdapter.prototype.formatInterrupt = function(session) { throw new Error('not implemented'); };
BackendAdapter.prototype.formatPermissionResponse = function(data) { throw new Error('not implemented'); };
BackendAdapter.prototype.formatSetPermissionMode = function(mode) { throw new Error('not implemented'); };
/** Build a preview user message record for buffer (before JSONL arrives) */
BackendAdapter.prototype.buildUserPreview = function(text, msgId) { return null; };
/** Extra actions after sending interrupt (e.g. SIGINT fallback) */
BackendAdapter.prototype.postInterrupt = function(session) {};

module.exports = { BackendAdapter, SessionHandle };
