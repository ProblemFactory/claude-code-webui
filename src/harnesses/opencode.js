'use strict';
// OpenCode (anomalyco) — the FIRST ACP harness (S8, owner decision 2026-09-05:
// OpenCode over Gemini CLI). `opencode acp` speaks ACP v1 (verified 1.18.29:
// loadSession + sessionCapabilities {close, fork, list, resume}, prompt
// image/embeddedContext, config options model + mode(build|plan),
// available_commands_update with the user's skills/commands). Models come from
// the agent's own provider config (models.dev catalog; `opencode auth login`)
// — VibeSpace holds no OpenCode credential.
//
// STORE (S9, B-03f2): opencode keeps sessions in its own sqlite
// (~/.local/share/opencode/opencode.db); there is no per-conversation file to
// locate (locate → null stays). The store FACTS come from `opencode serve`
// through src/opencode-serve.js (one lazily started instance per VibeSpace,
// installed by cli-env): discover = the serve session list (10s cache,
// negative cache, 1.5s budget — never stalls the poll), createReader = a
// serve-backed AcpSessionMessages whose records are rebuilt from
// /session/:id/message (a live session keeps reading its wrapper journal),
// forkSession = POST /session/:id/fork (ws-create mints the fork id BEFORE the
// spawn and resumes it; capsOf('opencode').fork flips only on the OpenAPI
// evidence), forkChain = [] (OpenCode records no fork parent — a fork is a
// copied session with "(fork #n)" in its title; parentID means a sub-agent
// child, not a fork).
const { acpHarness } = require('./acp');
const serve = require('../opencode-serve');
const os = require('os');
const path = require('path');

const harness = acpHarness({
  id: 'opencode',
  label: 'OpenCode',
  command: 'opencode',
  args: ['acp'],
  store: {
    transcriptDirs: [path.join(os.homedir(), '.local', 'share', 'opencode')],
    locate: () => null,
  },
  brand: '/brand/opencode.svg',
  terminal: { args: [], resumeFlag: '--session', modelFlag: '--model' },
});

Object.assign(harness.store, {
  // The background service is OPT-IN and lives behind a built-in plugin
  // (2026-09-07 owner decision, default OFF): naming it here is how the
  // client learns which control surface turns this store on — cli-env puts
  // plugins.serviceState(servicePlugin) on the /api/home harness row.
  servicePlugin: serve.SERVICE_PLUGIN_ID,
  // async ({activeSessions}) → session entries; [] (silently) until the serve
  // instance is up, when the CLI is missing, or while negative-cached
  discover: ({ activeSessions } = {}) => serve.facts().discover({ activeSessions }),
  Reader: serve.OpencodeServeSessionMessages,
  // (session, sessionId, {buffersDir, live}) — live sessions read the journal;
  // the synthetic stopped shape loads from the serve on prepare()
  createReader: (session, sessionId, opts) => new serve.OpencodeServeSessionMessages(session, sessionId, { ...(opts || {}), facts: serve.facts() }),
  // (id, {cwd}) → the NEW Session {id, title, directory, …}; throws LOUDLY
  // (not installed / parked / unreachable / no fork endpoint / 404)
  forkSession: (id, opts) => serve.facts().forkSession(id, opts || {}),
  forkChain: () => [],
  /** Why the store is unavailable right now (user-action error text). */
  unavailableReason: () => serve.facts().reasonUnavailable(),
  serveState: () => serve.facts().state(),
});

module.exports = harness;
