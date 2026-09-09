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
 * QUEUE OPERATION → the wrapper stdin frame. The ws layer speaks RELATIVE,
 * user-intent semantics and every adapter formats that same vocabulary:
 *   {op:'remove'|'steer'|'run-now', id}
 *   {op:'steer-all'|'run-all'}                 (no id — and run-all is its OWN
 *                                               verb, never run-now minus its id)
 *   {op:'reorder', id, afterId}                (afterId null = to the front)
 *   {op:'edit',    id, text}
 * The absolute RPC shapes (a full-order id array, a whole `input` array) are
 * synthesised in the WRAPPER, which is the only layer that can re-read the
 * live queue first — see src/backend-caps.js `queueVerbs`.
 * The harness's `inputModes.queueVerbs` row decides whether the op is offered
 * at all — ws-handler validates against it BEFORE calling this, with a coded
 * error the user can read. This throw is the second line of defense: an
 * adapter whose harness denies the op must REFUSE it with a reason, never
 * format a frame its wrapper would silently drop.
 */
BackendAdapter.prototype.formatQueueOp = function(op) { throw new Error('this backend has no input-queue operations'); };
/**
 * "STATE YOUR QUEUE AGAIN, OUT LOUD" → the wrapper stdin frame (2026-09-09).
 * A queue publication is a stdout record and stdout is a RING in every wrapper
 * that owns a queue, so a server that RESTARTS rebuilds a normalizer which has
 * never seen one: its `queue: []` is a GUESS, byte-identical whether the
 * wrapper's queue is empty or holds 25 items. The attach path asks; the answer
 * is an ordinary authoritative `queue_changed`, INCLUDING an empty one.
 * Only harnesses with a non-empty `inputModes.queueVerbs` implement it — the ws
 * layer gates on that row AND on the running wrapper's own `queueResync`
 * advert before calling, so a wrapper that predates the verb is never asked.
 */
BackendAdapter.prototype.formatQueueResync = function() { throw new Error('this backend publishes no input queue to re-state'); };
/**
 * LIVE RESPONSE-STYLE SWITCH → the wrapper stdin frame. Only harnesses whose
 * `responseStyle.live` caps row is true implement it; ws-handler checks the
 * caps row BEFORE calling and answers a coded error otherwise, so a spawn-only
 * harness (claude: --settings outputStyle, read once) refuses here rather than
 * writing a frame its wrapper would drop on the floor.
 */
BackendAdapter.prototype.formatSetResponseStyle = function(style) { throw new Error('this backend applies its response style at spawn only'); };
/**
 * READ-ONLY PERMISSION-RULE READ → the wrapper stdin frame (owner ruling 10).
 * Only harnesses whose `permissionRules` source is 'config-read' or 'acp'
 * implement it. Unlike the two verbs above, this one has NO ws message: the
 * only caller is the HTTP reader src/server/permission-rules.js, and both
 * gates live there — `read()` checks the caps row (`permissionRules.source` /
 * `.liveVerb`, never a backend id) and `readViaSession()` additionally checks
 * the RUNNING wrapper's own advert via `wrapperCaps().permissionRules` (the
 * 2.361.1/2.364.1 pair), refusing `wrapper-old` rather than writing a frame an
 * older wrapper would drop on the floor. A harness whose rules come off disk
 * (claude: the settings hierarchy, read server-side) never reaches this at all.
 * This throw is the last line of defence, not the gate.
 * There is deliberately NO write twin anywhere in this interface.
 */
BackendAdapter.prototype.formatReadPermissionRules = function(opts) { throw new Error('this backend does not expose its permission rules over the session'); };
/** Extra actions after sending interrupt (e.g. delayed SIGINT fallback) */
BackendAdapter.prototype.postInterrupt = function(session, sessionId) {};

module.exports = { BackendAdapter };
