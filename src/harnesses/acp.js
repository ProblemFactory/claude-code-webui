'use strict';
// ACP HARNESS DESCRIPTOR FACTORY (S8 of docs/design-harness-plugins.md §2.3).
// One call = one harness descriptor for any Agent Client Protocol v1 agent:
//   acpHarness({ id, label, command, args, env, store, brand, terminal })
// The wrapper (data/bin/acp-wrapper.js), adapter (adapters/acp.js) and
// normalizer (acp-message-manager.js) are SHARED by every ACP harness; the
// per-agent facts are the executable, its ACP args, optional env, where its
// transcripts live (for the store contract) and the brand mark. Capabilities
// beyond the static caps row (fork/list/load/image…) are read from the
// agent's `initialize` reply at spawn time by the wrapper — capability-driven,
// never hardcoded per agent.
const { BACKEND_CAPS } = require('../backend-caps');
const { AcpAdapter } = require('../adapters/acp');
const { AcpMessageManager, AcpSessionMessages } = require('../acp-message-manager');
const { NULL_QUOTA } = require('./null-quota');

const ACP_DEFAULT_CAPS = Object.freeze({
  pool: false, hotSwitch: 'unverified', planC: false, sealedOrders: false, resetCredit: false, quotaProbe: null,
  fork: false, streamProtocol: 'acp-events', peerDelivery: 'stash-only', frameFile: true,
});

function acpHarness({ id, label, command, args = ['acp'], env = {}, store = {}, brand = null, terminal = {}, caps = null } = {}) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`acpHarness: id must be a lowercase slug (got ${JSON.stringify(id)})`);
  if (typeof command !== 'string' || !command) throw new Error(`acpHarness('${id}'): command (the agent executable name) is required`);
  const capsRow = caps || BACKEND_CAPS[id] || ACP_DEFAULT_CAPS;
  if (capsRow.streamProtocol !== 'acp-events') throw new Error(`acpHarness('${id}'): caps.streamProtocol must be 'acp-events' (got ${capsRow.streamProtocol})`);
  return {
    id,
    label: label || id,
    kind: 'chat',
    caps: capsRow,
    Adapter: AcpAdapter,
    // cli-env resolves each ACP harness's executable ONCE (acpCommands[id] =
    // absolute path or null when not installed) and hands the shared wrapper
    // paths; everything else is this descriptor's own declaration.
    adapterConfig: (cfg) => ({
      harnessId: id,
      label: label || id,
      commandName: command,
      command: (cfg.acpCommands && cfg.acpCommands[id]) || null,
      acpArgs: args,
      env,
      chatWrapper: cfg.acpWrapper,
      ptyWrapper: cfg.ptyWrapper,
      terminalArgs: terminal.args || [],
      terminalResumeFlag: terminal.resumeFlag || null,
      terminalModelFlag: terminal.modelFlag || null,
    }),
    wrapper: 'data/bin/acp-wrapper.js',
    Normalizer: AcpMessageManager,
    store: {
      locate: typeof store.locate === 'function' ? store.locate : () => null,           // S3 name: (id, cwd) → path|null — ACP exposes no transcript read API; the wrapper journal is the history
      locateTranscript: typeof store.locate === 'function' ? store.locate : () => null, // S1 alias
      transcriptDirs: Array.isArray(store.transcriptDirs) ? store.transcriptDirs : [],
      conversationIdField: 'backendSessionId',
      // RESUME CONTINUITY (B-6b6d): deliberately NO `lastTurnModel`/
      // `lastTurnEffort` here. ACP itself exposes no way to ask an agent what a
      // stopped conversation was running, and the hook's PRESENCE is the whole
      // declaration (src/resume-continuity.js) — so a generic ACP harness sends
      // NOTHING on a resume and the agent's own record decides, rather than
      // having `<id>.defaultModel` (a NEW-session default) applied to a
      // continuation. A harness whose agent DOES name it adds the hook to its
      // own store: src/harnesses/opencode.js reads it off `opencode serve`.
      SessionMessages: AcpSessionMessages,
    },
    quota: NULL_QUOTA,            // no quota concept over ACP (usage_update is context size, not a subscription window)
    // AUTO-RESUME'S RESUME VERB (owner ruling 2026-09-08) — see the claude
    // descriptor for the law. FORM 'prompt': the shared acp-wrapper's
    // `chat-input` verb dispatches `session/prompt` when nothing is running
    // (its own promptQueue holds it otherwise), so the verb EXISTS and is
    // declared honestly. The other half does NOT: `quota` above is NULL_QUOTA,
    // so `caps.autoResume.signal` is false and `supported` is false — ACP v1
    // exposes no subscription window, so nothing can ever ARM an ACP session
    // and no surface offers the toggle. Declaring the verb anyway is the point
    // of deriving the row: the day an ACP agent reports a limit, this harness
    // already knows how to continue it, and nothing had to be guessed.
    resume: {
      form: 'prompt',
      deliver: (session, text, deps) => !!deps.sendChatInput(session, text),
    },
    creds: null,                  // the agent holds its own login; VibeSpace never manages ACP credentials
    settingsPrefix: id,
    // CONTEXT INJECTION (S6 kind 'acp'): the wrapper prefixes each prompt with
    // the /api/agent/prompt-context text (no hooks exist in a generic agent;
    // SessionStart is never honoured because it is never run).
    inject: { kind: 'acp', hookFile: null, hookEvents: [], sessionStartHonoured: false },
    acp: { command, args, env, brand: brand || null },
  };
}

module.exports = { acpHarness, ACP_DEFAULT_CAPS };
