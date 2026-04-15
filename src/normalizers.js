const { MessageManager } = require('./message-manager');
const { CodexMessageManager } = require('./codex-message-manager');

function createMessageManager(backend, sessionId) {
  return backend === 'codex'
    ? new CodexMessageManager(sessionId)
    : new MessageManager(sessionId);
}

module.exports = { createMessageManager };
