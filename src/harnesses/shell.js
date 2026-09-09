'use strict';
// Plain login-shell terminals — no AI, no chat pipeline (S1).
const { BACKEND_CAPS } = require('../backend-caps');
const { ShellAdapter } = require('../adapters/shell');

module.exports = {
  id: 'shell',
  label: 'Terminal',
  kind: 'terminal',
  caps: BACKEND_CAPS.shell,
  Adapter: ShellAdapter,
  adapterConfig: (cfg) => ({ ptyWrapper: cfg.ptyWrapper }),
  wrapper: null,
  Normalizer: null,
  store: null,
  quota: require('./null-quota.js').NULL_QUOTA, // no quota concept
  // AUTO-RESUME (owner ruling 2026-09-08): NEITHER half. There is no agent to
  // restart a turn on and no quota window to wait for, so the derived caps row
  // is the honest nothing and every surface — the status-bar toggle, the
  // engine's arm, the module's fire — refuses by that row rather than by an id.
  resume: null,
  settingsPrefix: null,
  inject: null,
};
