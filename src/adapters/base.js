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

class BackendAdapter {
}

/**
 * Protocol formatting methods — called by ws-handler to build
 * backend-specific JSON payloads. Eliminates if/else branching.
 */
BackendAdapter.prototype.formatChatInput = function(text, msgId) { throw new Error('not implemented'); };
BackendAdapter.prototype.formatInterrupt = function(session) { throw new Error('not implemented'); };
BackendAdapter.prototype.formatPermissionResponse = function(data) { throw new Error('not implemented'); };
BackendAdapter.prototype.formatSetPermissionMode = function(mode) { throw new Error('not implemented'); };
BackendAdapter.prototype.formatSetModel = function(model) { throw new Error('not implemented'); };
BackendAdapter.prototype.formatSetEffort = function(effort) { throw new Error('not implemented'); };
/**
 * QUEUE OPERATION → the wrapper stdin frame ({op:'steer'|'remove'|'steer-all', id}).
 * The harness's `inputModes` caps row (src/backend-caps.js) decides whether the
 * op is offered at all — ws-handler validates against it BEFORE calling this,
 * with a coded error the user can read. This throw is the second line of
 * defense: an adapter whose harness denies the op must REFUSE it with a reason,
 * never format a frame its wrapper would silently drop.
 */
BackendAdapter.prototype.formatQueueOp = function(op) { throw new Error('this backend has no input-queue operations'); };
/** Extra actions after sending interrupt (e.g. delayed SIGINT fallback) */
BackendAdapter.prototype.postInterrupt = function(session, sessionId) {};

module.exports = { BackendAdapter };
