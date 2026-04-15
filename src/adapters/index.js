const { ClaudeCodeAdapter } = require('./claude-code');
const { CodexAdapter } = require('./codex');

function createAdapterRegistry(config = {}) {
  const adapters = new Map();

  adapters.set('claude', new ClaudeCodeAdapter({
    claudeCmd: config.claudeCmd,
    chatWrapper: config.chatWrapper,
    ptyWrapper: config.ptyWrapper,
  }));

  adapters.set('codex', new CodexAdapter({
    codexCmd: config.codexCmd,
    codexSandboxSupported: config.codexSandboxSupported,
    chatWrapper: config.codexChatWrapper,
    ptyWrapper: config.ptyWrapper,
  }));

  return {
    adapters,
    list() {
      return [...adapters.keys()];
    },
    has(name) {
      return adapters.has(name);
    },
    get(name) {
      return adapters.get(name) || null;
    },
  };
}

module.exports = { createAdapterRegistry };
