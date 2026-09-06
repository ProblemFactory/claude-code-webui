import { ThemeManager, THEMES, BUILTIN_THEMES } from './themes.js';
import { installPluginClient } from './plugin-client.js';
import { installKeybindings } from './contributions.js';
import { buildGearMenu } from './gear-menu.js';
import { BUILD_VERSION } from './build-version.js';
import { track } from './telemetry-client.js';
import { ThemeEditor } from './theme-editor.js';
import { WsManager } from './ws.js';
import { WindowManager } from './window.js';
import { TerminalSession } from './terminal.js';
import { Sidebar } from './sidebar.js';
import { FileExplorer } from './file-explorer.js';
import { FileViewer } from './file-viewer.js';
import { CodeEditor } from './code-editor.js';
import { LayoutManager } from './layout.js';
import { ChatView } from './chat-view.js';
import { Resizer } from './resizer.js';
import { anchorFixedPopup, api, configureToasts, createPopover, createModalShell, fetchJson, initStateSync, installLongPressContextMenu, frontTruncate, escHtml, showContextMenu, showToast, showConfirmDialog, showInputDialog, applyUiPrefs, getUiPref, UI_SCALE_MIN, UI_SCALE_MAX, UI_FONT_MIN, UI_FONT_MAX, uiScale, setInstanceUrl } from './utils.js';
import { t, tc } from './i18n.js';
import { installManageAgents } from './manage-agents.js';
import { installPluginsUI } from './plugins-ui.js';
import { installUsageMeter } from './usage-meter.js';
import { installSessionLifecycle } from './session-lifecycle.js';
import { installSetupFlows } from './setup-flows.js';
import { MobileNav } from './mobile-nav.js';
import { setupDirAutocomplete } from './autocomplete.js';
import { getAvailableFonts } from './terminal.js';
import { SettingsManager } from './settings.js';
import { SETTINGS_SCHEMA } from './settings-schema.js';
import { SettingsUI } from './settings-ui.js';
import { openExternalEditor, closeExternalEditor } from './external-editor.js';
import { CommandMode } from './command-mode.js';
import { updateTaskbar as updateTaskbarFn } from './taskbar.js';
import { openBrowser as openBrowserFn } from './browser-window.js';
import { openDesktop as openDesktopFn } from './desktop-window.js';
import { openTaskDetail as openTaskDetailFn } from './task-detail.js';
import { openTaskLog as openTaskLogFn } from './task-log.js';
import { openUsageWindow } from './usage-window.js';
import { openJobsWindow, openInteractWindow } from './jobs-panel.js';
import { openSessionProps as openSessionPropsFn } from './session-props.js';
import { openWorkflowDetail as openWorkflowDetailFn } from './workflow-detail.js';
import { DesktopManager } from './desktop-manager.js';
import { StageManager, STAGE_ID } from './stage-manager.js';
import { registerWindowType, svgIcon16 } from './window-types.js';
import { CustomizeMode, applyArrangement } from './customize-mode.js';
import { installSessionPalette } from './session-palette.js';
import { installUserTodos } from './user-todos-panel.js';
import { BACKEND_META, createBackendIconHtml, getSessionKey, pickAgentIdentity, settingsPrefixFor, effortLabel } from './agent-meta.js';

const BACKEND_SESSION_OPTIONS = {
  claude: {
    models: [{ id: '', label: t('Default') }, { id: 'fable', label: t('fable (latest, 200k)') }, { id: 'fable[1m]', label: t('fable[1m] (latest, 1M)') }, { id: 'opus', label: t('opus (latest, 200k)') }, { id: 'opus[1m]', label: t('opus[1m] (latest, 1M)') }, { id: 'sonnet', label: t('sonnet (latest)') }, { id: 'sonnet[1m]', label: t('sonnet[1m] (latest, 1M)') }, { id: 'haiku', label: t('haiku (latest)') }],
    permissions: [
      { value: '', label: t('Default') },
      { value: 'auto', label: t('Auto') },
      { value: 'bypassPermissions', label: t('Bypass') },
      { value: 'plan', label: t('Plan') },
      { value: 'acceptEdits', label: t('Accept Edits') },
    ],
    efforts: [
      { value: '', label: t('Auto (model default)') },
      { value: 'low', label: t('Low') },
      { value: 'medium', label: t('Medium') },
      { value: 'high', label: t('High') },
      { value: 'xhigh', label: t('XHigh') },
      { value: 'max', label: t('Max (Opus only)') },
      { value: 'ultracode', label: t('Ultracode (xhigh + workflows)') },
    ],
  },
  codex: {
    models: [{ id: '', label: t('Default') }],
    permissions: [
      { value: '', label: t('Default') },
      { value: 'read-only', label: t('Read Only') },
      { value: 'safe-yolo', label: t('Safe Yolo') },
      { value: 'yolo', label: t('Yolo') },
    ],
    efforts: [
      { value: '', label: t('Auto (model default)') },
      { value: 'minimal', label: t('Minimal') },
      { value: 'low', label: t('Low') },
      { value: 'medium', label: t('Medium') },
      { value: 'high', label: t('High') },
      { value: 'xhigh', label: t('XHigh') },
    ],
  },
  // OpenCode over ACP (S8): models come from the agent at session start
  // (/api/available-models fills them in once one has run); "permission" =
  // the agent's session mode; no effort ladder (META caps.effort false hides the row).
  opencode: {
    models: [{ id: '', label: t('Default') }],
    permissions: [
      { value: '', label: t('Default') },
      { value: 'build', label: t('Build') },
      { value: 'plan', label: t('Plan') },
    ],
    efforts: [{ value: '', label: t('Auto (model default)') }],
  },
};

// Fetch available models from server (Claude from bootstrap/v1/models API, Codex from cache)
fetchJson('/api/available-models').then(data => {
  if (!data) return;
  const toSchemaOptions = (models) => models.map(m => ({ value: m.id, label: m.label || m.id || t('Default') }));
  for (const be of Object.keys(data)) { // ACP harnesses (S8): the agent's offered models, learned server-side from session/config records
    if (be === 'claude' || be === 'codex' || !BACKEND_SESSION_OPTIONS[be] || !data[be]?.length) continue;
    BACKEND_SESSION_OPTIONS[be].models = data[be];
    if (SETTINGS_SCHEMA[`${be}.defaultModel`]) SETTINGS_SCHEMA[`${be}.defaultModel`].options = toSchemaOptions(data[be]);
  }
  if (data.claude?.length) {
    BACKEND_SESSION_OPTIONS.claude.models = data.claude;
    SETTINGS_SCHEMA['claude.defaultModel'].options = toSchemaOptions(data.claude);
  }
  if (data.codex?.length) {
    BACKEND_SESSION_OPTIONS.codex.models = data.codex;
    SETTINGS_SCHEMA['codex.defaultModel'].options = toSchemaOptions(data.codex);
    // Codex effort levels are model-specific since GPT-5.6 (sol/terra add
    // max+ultra) — build the dropdown from the union of the models' reported
    // levels instead of the stale hardcoded ladder. Rank keeps a sane order.
    const rank = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const union = [...new Set(data.codex.flatMap(m => m.efforts || []))]
      .sort((a, b) => (rank.indexOf(a) + 1 || 99) - (rank.indexOf(b) + 1 || 99));
    if (union.length) {
      const efforts = [{ value: '', label: t('Auto (model default)') },
        ...union.map(e => ({ value: e, label: effortLabel('codex', e, { capitalize: true }) }))]; // 'ultra' carries its delegation hint (META.effortHints)
      BACKEND_SESSION_OPTIONS.codex.efforts = efforts;
      SETTINGS_SCHEMA['codex.defaultEffort'].options = efforts.map(e => ({ value: e.value, label: e.label }));
    }
  }
});
// Fetch effort levels + permission modes from server (parsed from claude --help)
fetchJson('/api/session-options').then(data => {
  if (!data) return;
  if (data.effortLevels?.length) {
    const efforts = [{ value: '', label: t('Auto (model default)') }, ...data.effortLevels.map(e => ({ value: e, label: e.charAt(0).toUpperCase() + e.slice(1) }))];
    BACKEND_SESSION_OPTIONS.claude.efforts = efforts;
    SETTINGS_SCHEMA['claude.defaultEffort'].options = efforts.map(e => ({ value: e.value, label: e.label }));
  }
  if (data.permissionModes?.length) {
    const perms = [{ value: '', label: t('Default') }, ...data.permissionModes.map(p => ({ value: p, label: p }))];
    BACKEND_SESSION_OPTIONS.claude.permissions = perms;
    SETTINGS_SCHEMA['claude.defaultPermissionMode'].options = perms.map(p => ({ value: p.value, label: p.label }));
  }
});

// localStorage keys that ride the config export's clientPrefs section — the
// export gather and the import write-back MUST use the same list (a key only
// in one direction silently drops). Per-device view prefs included on purpose:
// migrating to a new deployment shouldn't reset language/usage-view choices.
const CLIENT_PREF_KEYS = [
  'theme', 'termFontSize', 'termFontFamily', 'taskbarHeight',
  'vibespace.lang', 'vibespace.usageAccount', 'vibespace.usageAccountCodex',
  'vibespace.quotaRefreshAck', 'vs-onboarded',
  'vibespace.uiScale', 'vibespace.uiFontScale',
];

class App {
  constructor() {
    /** Centralized mobile detection — all code should use app.isMobile instead of matchMedia */
    this.isMobile = window.matchMedia('(max-width: 768px)').matches;
    /** Touch-primary device (phones AND tablets) — hover/right-click unavailable */
    this.isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    // Long-press = right-click on touch devices (iOS never fires contextmenu natively)
    if (this.isTouch) installLongPressContextMenu();

    this.settings = new SettingsManager();
    // Toast cards anchor at the inbox button and read their duration live
    configureToasts({
      getSeconds: () => this.settings.get('taskbar.toastSeconds'),
      getAnchor: () => document.getElementById('taskbar-user-todos'),
    });
    this.themeManager = new ThemeManager();
    this.ws = new WsManager();
    this.wm = new WindowManager(document.getElementById('workspace'));
    this.wm.app = this; // mediator back-ref (title-bar billing badge → switcher)
    this.wm._settings = this.settings;
    this.wm._app = this;
    // Re-render all tab bars when tab wrap setting changes
    // Hook-card visibility: pure CSS toggle so flipping the setting applies
    // to every open chat instantly, both directions (no re-render).
    const applyHookVis = () => document.body.classList.toggle('hide-hook-cards', this.settings.get('chat.showHookCards') === false);
    applyHookVis();
    this.settings.on('chat.showHookCards', applyHookVis);
    setTimeout(applyHookVis, 2000); // re-apply once the async settings load lands
    // Empty-thinking visibility (chat.hideEmptyThinking, default ON): same
    // pure-CSS body-class toggle. Flipping it changes run-collapse adjacency
    // (hidden cards are transparent to runs) — re-decorate open chats too.
    const applyEmptyThink = () => {
      document.body.classList.toggle('hide-empty-thinking', this.settings.get('chat.hideEmptyThinking') !== false);
      for (const [, s] of this.sessions || []) s._updateRuns?.(); // constructor runs this before this.sessions exists
    };
    applyEmptyThink();
    this.settings.on('chat.hideEmptyThinking', applyEmptyThink);
    setTimeout(applyEmptyThink, 2000);
    // Keep the activity spinner ROTATING under prefers-reduced-motion (opt-in
    // — the default pulse read as "blinking/broken" to some users).
    const applySpinRM = () => document.body.classList.toggle('spin-under-rm', this.settings.get('chat.reducedMotionSpin') === true);
    applySpinRM();
    this.settings.on('chat.reducedMotionSpin', applySpinRM);
    setTimeout(applySpinRM, 2000);
    // Consecutive thinking/Bash run collapse: re-decorate every open chat when
    // the setting flips (the per-view MutationObserver only fires on content).
    this.settings.on('chat.collapseRuns', () => {
      for (const [, s] of this.sessions) s._updateRuns?.();
    });
    this.settings.on('window.tabWrap', () => {
      for (const [, win] of this.wm.windows) {
        if (win._tabChain && win._tabChain.tabs[0] === win.id) this.wm._renderTabBar(win._tabChain);
      }
    });
    this.sessions = new Map();
    this.attachedServerSessions = new Set();
    this.layoutManager = new LayoutManager(this);
    this.desktopManager = new DesktopManager(this);
    this.stage = new StageManager(this); // dynamic desktop view (docs/design-dynamic-desktop.md)
    // NOTE: stage.init() (its SyncStore registration) runs AFTER initStateSync
    // below — calling it here dropped every slot/workspace write silently
    // (getStateSync() was still undefined; real report: the placeholder
    // "never moved" because the dragged slot never persisted).

    // Tag every new window with the active desktop ID
    const origCreateWindow = this.wm.createWindow.bind(this.wm);
    this.wm.createWindow = (opts) => {
      const win = origCreateWindow(opts);
      // Don't clobber a _desktopId set DURING creation: createWindow's tail
      // focus runs the stage materialization, whose identity adoption may
      // already have assigned the window's true home desktop.
      if (!win._desktopId && this.desktopManager.activeDesktopId) {
        win._desktopId = this.desktopManager.activeDesktopId;
      }
      return win;
    };

    this.wm.onWindowsChanged = () => {
      this.updateTaskbar();
      this.layoutManager.scheduleAutoSave();
      this._notifySidebarFocus();
      this._updateMobileNavTitle();
    };
    this.sidebar = new Sidebar(this);

    // Load settings asynchronously (non-blocking — modules use defaults until loaded)
    this.settings.load();

    // Sync settings from other clients via WebSocket
    this.ws.onGlobal((msg) => {
      if (msg.type === 'settings-updated' && msg.settings) {
        this.settings.applyRemote(msg.settings);
      }
      if (msg.type === 'custom-themes-updated' && msg.themes) {
        this._applyCustomThemesFromServer(msg.themes);
      }
      if (msg.type === 'accounts-updated' && Array.isArray(msg.accounts)) {
        this._accounts = { ...(this._accounts || {}), accounts: msg.accounts, defaultAccountId: msg.defaultAccountId || null, defaultCodexAccountId: msg.defaultCodexAccountId || null };
        // Live-re-render an OPEN Manage Agents surface — without this the
        // roster only updated on the next manual reopen, so adding an account
        // (esp. one never logged in) left the page unchanged (inc-msl890ua).
        try { this._agentsRefreshHook?.(); } catch {}
      }
      if (msg.type === 'pool-auto-switched' && Array.isArray(msg.affected)) {
        // B-6217 v2 auto+COLD: the server re-pointed a pool and picked THIS
        // client (exactly one) to restart the affected conversations — every
        // client acting would race duplicate resumes.
        for (const sess of msg.affected) { try { this._poolColdRestart(sess, msg.poolId); } catch {} }
      }
      if (msg.type === 'layout-restored') {
        // Another client restored a rollback point. Without this our stale
        // in-memory layout would be written back on the next window change,
        // silently undoing the restore (adversarial review).
        showToast(t('Layout restored on another device — reloading…'));
        setTimeout(() => location.reload(), 900);
        return;
      }
      if (msg.type === 'server-notice' && msg.text) {
        // Probe-reported condition (2.226.0): server-side silent failures now
        // surface as toasts (+ notification history) instead of dying in the
        // server log. Key-deduped server-side, once per boot per issue.
        showToast(msg.text, { type: msg.level >= 2 ? 'error' : undefined });
      }
      if (msg.type === 'sysinfo-alert') {
        // Event-loop degradation (2.235.0): the "everything is slow but CPU
        // looks fine" state — surface it the moment it happens instead of
        // being diagnosed from telemetry after the fact.
        if (msg.kind === 'evloop') {
          showToast(
            t('The server is degraded — its main thread is saturated ({lag}ms median lag). Everything will feel slow; sessions are NOT dead.', { lag: msg.lagMs }),
            { type: msg.level >= 2 ? 'error' : undefined },
          );
          return;
        }
        // Memory pressure (2.216.0, userL's OOM kill): warn BEFORE the
        // kernel kills the pod (which takes every dtach session with it).
        this.sidebar?._railSysBadge?.(msg.pct);
        const top = (msg.procs || [])[0];
        const topStr = top ? ` ${t('Top consumer:')} ${Math.round(top.rss / 1048576)}MB ${(top.cmd || '').slice(0, 48)}` : '';
        showToast(
          t('Memory at {pct}% of the container limit — an OOM kill would end EVERY session.', { pct: msg.pct }) + topStr,
          { type: msg.level >= 2 ? 'error' : undefined },
        );
      }
    });

    // Anthropic accounts (subscription ↔ API key, per-session billing identity)
    this._accounts = { accounts: [], defaultAccountId: null, subscription: {}, cliKey: {} };
    this.refreshAccounts();

    // Load custom themes from server
    this._loadCustomThemes();

    this._setupToolbar();
    this._setupDialogs();
    this._setupWelcome();
    this._setupGlobalSettings();
    this._setupChromeContextMenus();
    if (!this.isMobile) installSessionPalette(this);
    // THE document-level keybinding dispatcher for registry chords
    // (contributions.js registerKeybinding, Plugin Ph1): ONE bubble-phase
    // listener bound for the app's lifetime under an AbortController. Core
    // shortcuts keep their own capture listeners (command-mode.js /
    // session-palette.js say why); plugin bindings ride this one.
    this._contribCtl = new AbortController();
    installKeybindings(document, { signal: this._contribCtl.signal, getCtx: () => ({ app: this }) });
    this._setupGridConfig();
    this._setupLayoutManager();
    this._setupUsage();
    installUserTodos(this); // global "For you" inbox (agent-filed user TODOs)
    this._initMaintenanceBanner(); // operator-onsite transparency strip
    this._commandMode = new CommandMode(this, this.settings);

    // Listen for editor open/close requests (from editor-helper.sh via server HTTP→WebSocket)
    // the instance's public address can flip while the tab is open (Ports
    // panel → This VibeSpace): every link helper reads it live, no reload
    this.ws.onGlobal((msg) => { if (msg.type === 'instance-url') setInstanceUrl(msg.status?.effectiveUrl || null); });
    // S9: a harness capability verified at runtime (opencode fork = the serve
    // OpenAPI evidence, probed lazily AFTER this client's /api/home) reaches
    // every open client — the sidebar's Fork row reads BACKEND_META caps
    this.ws.onGlobal((msg) => {
      if (msg.type !== 'harness-caps-updated' || !msg.backend || !msg.caps || !BACKEND_META[msg.backend]?.caps) return;
      Object.assign(BACKEND_META[msg.backend].caps, msg.caps);
      try { this.sidebar?._render?.(); } catch {}
    });
    this.ws.onGlobal((msg) => {
      if (msg.type === 'editor-open' && msg.filePath && msg.signalPath) {
        this._openExternalEditor(msg.filePath, msg.signalPath, msg.sessionId, msg.host);
      } else if (msg.type === 'editor-close' && msg.signalPath) {
        this._closeExternalEditor(msg.signalPath);
      }
    });

    fetch('/api/home').then(r => {
      if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
      return r.json();
    }).then(d => {
      document.getElementById('input-cwd').placeholder = d.home;
      this._localHome = d.home; // restored as the cwd hint when host → Local (B-0d70)
      this._authEnabled = !!d.authEnabled;
      this._ssoEnabled = !!d.ssoEnabled; // Clerk SSO on → password step/import ignored
      this._repoDir = d.repoDir || null; // server install dir (⚙ self-update)
      this._publicUrlDefault = d.publicUrlDefault || null; // cluster-injected agentd.publicUrl default (settings placeholder)
      setInstanceUrl(d.instancePublicUrl || null); // the address every "link to something here" helper uses (utils.absUrl)
      for (const h of Array.isArray(d.harnesses) ? d.harnesses : []) { // ACP harnesses (S8): offered only where their CLI is installed
        const opt = document.querySelector(`#input-backend option[value="${CSS.escape(String(h.id))}"]`);
        if (opt) opt.hidden = !h.installed;
        // S9: runtime-verified caps (opencode fork = the serve OpenAPI evidence) replace the shipped guess
        if (h.caps && BACKEND_META[h.id]?.caps) Object.assign(BACKEND_META[h.id].caps, h.caps);
      }
    }).catch(()=>{});

    // Initialize unified state sync (server-persisted, versioned diff broadcast, reconnect recovery)
    initStateSync(this.ws);
    this.stage.init(); // stage SyncStore — must follow initStateSync (see constructor note)
    installPluginClient(this); // Plugin Ph2: contributed iframe windows register as window types (needs ws for live updates)

    // Restore layout after WebSocket is connected (needs active sessions)
    this.ready = new Promise(resolve => {
      setTimeout(async () => {
        await this.layoutManager.loadAutoSave();
        resolve();
      }, 1500);
    });

    // Re-attach all terminal sessions on reconnect (chat sessions handle their own)
    this.ws.onStateChange((connected) => {
      if (!connected) return;
      this._checkBundleFreshness(); // stale-bundle tab after a server update → one-shot reload
      if (!this._vncAvailable) this._probeVncAvailability(); // may have failed during a restart-window page load
      // Broadcast-only stores go stale across an outage — refetch once per
      // reconnect (2.219.0 audit: maintenance banner + settings missed
      // changes made while this tab was disconnected)
      fetchJson('/api/maintenance').then((m) => { if (m) this._renderMaintenance?.(m); }).catch(() => {});
      try { this.settings?.refetch?.(); } catch {}
      // user-state too (2.223.4 — the userW names/stars/archives blackout):
      // a boot-time fetch that failed during a restart window left the tab
      // permanently stateless; reconnect re-applies the authoritative copy.
      try { this.sidebar?._fetchUserState?.(); } catch {}
      // Task Groups + session statuses are ALSO broadcast-only mirrors: an
      // agent's vibespace-status/vibespace-task writes and another client's
      // group edits during the outage never arrive, so the board and the
      // status chips render stale state as current until a full reload (and a
      // boot fetch lost to a restart window leaves _tasksLoaded false, which
      // pins task-detail windows on "Loading task…" forever).
      try { this.sidebar?._fetchTasks?.(); } catch {}
      fetchJson('/api/session-status').then((d) => {
        const sb = this.sidebar;
        if (!d?.statuses || !sb) return;
        sb._sessionStatuses = d.statuses;
        sb._render?.();
        sb._lastAttnSig = null; // declared attention may have changed while we were away
        sb.refreshTaskAttention?.();
      }).catch(() => {});
      for (const [winId, session] of this.sessions) {
        if (session instanceof TerminalSession && session.sessionId) {
          this.ws.send({ type: 'attach', sessionId: session.sessionId });
          // Re-attach registers this client at the 120×30 placeholder; the
          // DOM size didn't change so ResizeObserver stays quiet and no real
          // resize would follow. Re-fit explicitly, or once the heartbeat
          // evicts the old ghost the session would shrink to the placeholder.
          requestAnimationFrame(() => { try { session.fit(); } catch {} });
        }
      }
    });

    // Desktop (noVNC) availability gates the ⚙ menu entry + toolbar button.
    // Probed at startup AND re-probed on every ws reconnect: a page that
    // loads during a server restart window gets a failed probe, and a
    // once-only check would hide the Desktop feature for the whole page
    // session (real report — userW onboarded mid-update, "desktop功能直接
    // 被禁用"; F5 was the only cure).
    this._probeVncAvailability();

    // Mobile nav bar + gestures (only on mobile)
    this._mobileNav = this.isMobile ? new MobileNav(this) : null;
  }

  _updateMobileNavTitle() {
    if (this._mobileNav) this._mobileNav.updateTitle();
  }

  _setupToolbar() {
    document.querySelectorAll('.layout-btn[data-layout]').forEach(btn => btn.addEventListener('click', () => this.wm.applyLayout(btn.dataset.layout)));
    document.getElementById('btn-new-session').addEventListener('click', () => this.showNewSessionDialog());
    document.getElementById('btn-file-explorer').addEventListener('click', () => this.openFileExplorer());
    document.getElementById('btn-terminal').addEventListener('click', async (e) => {
      // Host-aware (like Files): with remote hosts registered, pick where the
      // shell runs; with none, open a local shell directly (zero friction).
      const btn = e.currentTarget;
      let hostsList = [];
      try { const d = await fetchJson('/api/hosts'); hostsList = d?.hosts || []; } catch {}
      if (!hostsList.length) return this.openShellTerminal();
      const r = btn.getBoundingClientRect();
      showContextMenu(r.left, r.bottom + 4, [
        { label: t('Local'), action: () => this.openShellTerminal() },
        ...hostsList.map(h => ({ label: h.name, action: () => this.openShellTerminal(undefined, { hostId: h.id }) })),
      ]);
    });
    document.getElementById('btn-browser').addEventListener('click', () => this.openBrowser());
    document.getElementById('btn-desktop').addEventListener('click', () => this.openDesktop());

    // Apply toolbar/taskbar/sidebar chrome customization settings.
    // While CustomizeMode is active, hidden elements stay ON the canvas
    // (dimmed via .cz-off from _refresh) instead of display:none, so the
    // user can click them back on.
    const applyChromeSettings = () => {
      const s = this.settings;
      const cz = this._customize?.active;
      const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = (on || cz) ? '' : 'none'; };
      show('layout-presets', s.get('toolbar.showLayoutPresets'));
      show('btn-presets', s.get('toolbar.showPresetsButton'));
      show('btn-terminal', s.get('toolbar.showTerminalButton'));
      show('btn-browser', s.get('toolbar.showBrowserButton'));
      show('btn-desktop', s.get('toolbar.showDesktopButton') && this._vncAvailable);
      show('btn-file-explorer', s.get('toolbar.showFileExplorerButton'));
      const vis = s.get('taskbar.visibility') || 'show';
      show('taskbar', vis !== 'hidden');
      show('taskbar-resize-handle', vis === 'show' && !cz); // no drag-resize while auto-hidden/editing
      document.body.classList.toggle('taskbar-autohide', vis === 'autohide');
      this._ensureTaskbarHotzone(vis === 'autohide');
      // NOTE: no `vis` coupling — previews may be hosted in the toolbar now
      // (chrome.arrangement); a hidden taskbar hides only its own children
      show('desktop-previews', s.get('taskbar.showDesktopPreviews'));
      show('taskbar-user-todos', s.get('taskbar.showUserTodos'));
      show('taskbar-usage', s.get('taskbar.showUsage'));
      show('taskbar-status', s.get('taskbar.showWindowCount'));
      document.body.classList.toggle('taskbar-top', s.get('taskbar.position') === 'top');
      document.body.classList.toggle('sidebar-right', s.get('sidebar.position') === 'right');
      // Per-area alignment (chrome.zoneAlign): window items left/center
      // (Win11-style), toolbar-center content left/center/right, tray at the
      // taskbar's left or right end (order swap; [CMD] stays leftmost)
      const za = s.get('chrome.zoneAlign') || {};
      const items = document.getElementById('taskbar-items');
      // `safe center` falls back to start when items overflow (plain center
      // makes the left overflow unreachable in a scroll container)
      if (items) items.style.justifyContent = za['taskbar-items'] === 'center' ? 'safe center' : '';
      const centerZone = document.querySelector('[data-zone="toolbar-center"]');
      if (centerZone) centerZone.style.justifyContent =
        za['toolbar-center'] === 'left' ? 'flex-start' : za['toolbar-center'] === 'right' ? 'flex-end' : '';
      const tray = document.getElementById('taskbar-tray');
      const trayLeft = za['taskbar-tray'] === 'left';
      if (tray) tray.style.order = trayLeft ? '-1' : '';
      const cmd = document.getElementById('cmd-indicator');
      if (cmd) cmd.style.order = trayLeft ? '-2' : '';
      // re-apply main-wrapper margin on the correct side
      this.sidebar?._applySidebarLayoutWidth?.();
    };
    this._applyChromeSettings = applyChromeSettings;
    applyChromeSettings();
    for (const k of ['toolbar.showLayoutPresets', 'toolbar.showPresetsButton', 'toolbar.showTerminalButton',
                     'toolbar.showBrowserButton', 'toolbar.showFileExplorerButton',
                     'taskbar.visibility', 'taskbar.showDesktopPreviews', 'taskbar.showUserTodos', 'taskbar.showUsage', 'taskbar.showWindowCount',
                     'taskbar.position', 'sidebar.position', 'chrome.zoneAlign']) {
      this.settings.on(k, applyChromeSettings);
    }
    // Element arrangement (which zone hosts which movable, in what order) +
    // per-spring configs — written by CustomizeMode, synced multi-client.
    // Desktop-only: mobile has its own chrome (MobileNav, two-level sidebar),
    // so a desktop arrangement must not re-parent elements there — moving
    // e.g. desktop-previews into an extra toolbar row made that row render
    // on phones (the :empty auto-hide no longer applied).
    const applyArr = () => {
      if (this.isMobile) return;
      applyArrangement(this.settings.get('chrome.arrangement'), this.settings.get('chrome.springs'));
    };
    applyArr();
    this.settings.on('chrome.arrangement', applyArr);
    this.settings.on('chrome.springs', applyArr);
  }

  // Auto-hide taskbar: a thin fixed hotzone on the taskbar's screen edge — the
  // taskbar (position:fixed in this mode, so the workspace keeps full height)
  // slides in while the pointer is over the hotzone or the taskbar itself, and
  // slides away when it leaves. Pure CSS transform; no reflow churn.
  _ensureTaskbarHotzone(on) {
    let hz = document.getElementById('taskbar-hotzone');
    if (!on) { hz?.remove(); return; }
    if (hz) return;
    hz = document.createElement('div');
    hz.id = 'taskbar-hotzone';
    document.body.appendChild(hz);
    const taskbar = document.getElementById('taskbar');
    const reveal = () => document.body.classList.add('taskbar-revealed');
    const conceal = (e) => {
      // stay revealed while a popover spawned from the taskbar is open
      if (document.querySelector('.taskbar-window-list, .usage-popup:not(.hidden), [data-popover]')) return;
      document.body.classList.remove('taskbar-revealed');
    };
    hz.addEventListener('mouseenter', reveal);
    // The taskbar element PERSISTS across hotzone recreation (toggling
    // autohide off/on) — re-adding its listeners each time stacked duplicates.
    if (!taskbar._hzWired) {
      taskbar._hzWired = true;
      taskbar.addEventListener('mouseenter', reveal);
      taskbar.addEventListener('mouseleave', conceal);
    }
    hz.addEventListener('mouseleave', (e) => { if (e.relatedTarget !== taskbar && !taskbar.contains(e.relatedTarget)) conceal(e); });
  }

  // In-place chrome customization (the pattern desktops/browsers use: right-
  // click the bar itself). These write the SAME settings as the Settings
  // dialog — the menu is just a discoverable shortcut.
  // ── Maintenance banner (2.189.0): when an operator/support agent is
  // actively connected to this instance troubleshooting it, a persistent
  // amber strip says so (transparency for onsite debugging). Server state
  // survives restarts and auto-expires; the strip is a normal flex child of
  // #main-wrapper, so the workspace reflows proportionally under it.
  _initMaintenanceBanner() {
    const fmtT = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const render = (m) => {
      let el = document.getElementById('maintenance-banner');
      if (!m?.active) { el?.remove(); document.getElementById('mb-timeline')?.remove(); clearTimeout(this._maintTimer); return; }
      if (!el) {
        el = document.createElement('div');
        el.id = 'maintenance-banner';
        const wrap = document.getElementById('main-wrapper');
        if (!wrap) return;
        wrap.insertBefore(el, wrap.firstChild);
      }
      const since = m.since ? fmtT(m.since) : '';
      const ups = m.updates || [];
      const latest = ups[ups.length - 1] || null;
      el.innerHTML = `<span class="mb-ic">🛠</span><span class="mb-text">${escHtml(t('Maintenance: a support agent is connected to this instance for troubleshooting'))}`
        + `${m.message ? ' — ' + escHtml(m.message) : ''}`
        + `${since ? ` <span class="mb-since">(${escHtml(t('since {time}', { time: since }))})</span>` : ''}</span>`
        // live progress: the latest update line pulses in as it changes, so the
        // user SEES the troubleshooting move instead of a frozen banner
        + (latest ? `<span class="mb-update" data-ts="${latest.ts}">▸ ${escHtml(latest.text)} <span class="mb-since">${fmtT(latest.ts)}</span></span>` : '')
        + (ups.length > 1 ? `<button class="mb-log-btn" title="${escHtml(t('Show the full troubleshooting timeline'))}">${escHtml(t('{n} updates', { n: ups.length }))} ▾</button>` : '');
      // pulse only when the latest update actually CHANGED (rebuilds happen on
      // every broadcast — a steady pulse would be noise)
      const upEl = el.querySelector('.mb-update');
      if (upEl && latest && this._maintLastUpdTs !== latest.ts) {
        this._maintLastUpdTs = latest.ts;
        upEl.classList.add('mb-pulse');
        setTimeout(() => upEl.classList.remove('mb-pulse'), 1600);
      }
      el.querySelector('.mb-log-btn')?.addEventListener('click', () => {
        const old = document.getElementById('mb-timeline');
        if (old) { old.remove(); return; }
        const panel = document.createElement('div');
        panel.id = 'mb-timeline';
        panel.dataset.popover = '1'; // global Escape closes it
        panel.innerHTML = [...ups].reverse().map(u =>
          `<div class="mb-tl-row"><span class="mb-tl-time">${fmtT(u.ts)}</span><span>${escHtml(u.text)}</span></div>`).join('');
        el.appendChild(panel);
      });
      clearTimeout(this._maintTimer);
      if (m.until) this._maintTimer = setTimeout(() => render({ active: false }), Math.max(1000, m.until - Date.now()));
    };
    this._renderMaintenance = render; // reconnect refetch re-renders through this
    fetchJson('/api/maintenance').then((m) => { if (m) render(m); }).catch(() => {});
    this.ws.onGlobal((msg) => { if (msg.type === 'maintenance-updated') render(msg.maintenance); });
  }

  _setupChromeContextMenus() {
    const s = this.settings;
    const check = (label, on) => (on ? '\u2713 ' : '\u2003 ') + label;
    const taskbar = document.getElementById('taskbar');
    taskbar?.addEventListener('contextmenu', (e) => {
      // let taskbar ITEMS keep their own menus; empty areas customize
      if (e.target.closest('.taskbar-item, .desktop-preview, .taskbar-usage')) return;
      e.preventDefault();
      const vis = s.get('taskbar.visibility') || 'show';
      showContextMenu(e.clientX, e.clientY, [
        { label: t('Customize UI…'), action: () => this._customize.enter() },
        { separator: true },
        { label: check(t('Dock to top'), s.get('taskbar.position') === 'top'), action: () => s.set('taskbar.position', s.get('taskbar.position') === 'top' ? 'bottom' : 'top') },
        { label: check(t('Auto-hide'), vis === 'autohide'), action: () => s.set('taskbar.visibility', vis === 'autohide' ? 'show' : 'autohide') },
        { label: check(t('Desktop previews'), s.get('taskbar.showDesktopPreviews')), action: () => s.set('taskbar.showDesktopPreviews', !s.get('taskbar.showDesktopPreviews')) },
        { label: check(t('For-you inbox'), s.get('taskbar.showUserTodos')), action: () => s.set('taskbar.showUserTodos', !s.get('taskbar.showUserTodos')) },
        { label: check(t('Usage meters'), s.get('taskbar.showUsage')), action: () => s.set('taskbar.showUsage', !s.get('taskbar.showUsage')) },
        { label: check(t('Window count'), s.get('taskbar.showWindowCount')), action: () => s.set('taskbar.showWindowCount', !s.get('taskbar.showWindowCount')) },
        { label: t('All settings\u2026'), action: () => this._settingsUI?.open() },
      ]);
    });
    const toolbar = document.getElementById('toolbar');
    toolbar?.addEventListener('contextmenu', (e) => {
      // Chrome elements are drag-movable BETWEEN the bars (customize mode), so
      // this bar must exempt the same element classes the taskbar does — a
      // preview/usage/taskbar-item dragged up here owns its own menu
      // (2.250.1, real report: right-clicking a desktop preview moved into the
      // toolbar showed "Customize UI…" instead of Rename/Delete).
      if (e.target.closest('button, select, input, .taskbar-item, .desktop-preview, .desktop-preview-wrapper, .taskbar-usage')) return;
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: t('Customize UI…'), action: () => this._customize.enter() },
        { separator: true },
        { label: check(t('Layout presets'), s.get('toolbar.showLayoutPresets')), action: () => s.set('toolbar.showLayoutPresets', !s.get('toolbar.showLayoutPresets')) },
        { label: check(t('Browser button'), s.get('toolbar.showBrowserButton')), action: () => s.set('toolbar.showBrowserButton', !s.get('toolbar.showBrowserButton')) },
        { label: check(t('Files button'), s.get('toolbar.showFileExplorerButton')), action: () => s.set('toolbar.showFileExplorerButton', !s.get('toolbar.showFileExplorerButton')) },
        { label: check(t('Sidebar on right'), s.get('sidebar.position') === 'right'), action: () => s.set('sidebar.position', s.get('sidebar.position') === 'right' ? 'left' : 'right') },
        { label: t('All settings\u2026'), action: () => this._settingsUI?.open() },
      ]);
    });
    // Extra rows (#toolbar-row2 / #taskbar-row2) are ZONES like the bars —
    // without their own handler a right-click there fell through to the
    // browser's native menu (real report). Same menu as their parent bar;
    // same movable-element exemptions.
    for (const [rowId, barId] of [['toolbar-row2', 'toolbar'], ['taskbar-row2', 'taskbar']]) {
      const row = document.getElementById(rowId);
      const bar = document.getElementById(barId);
      if (!row || !bar) continue;
      row.addEventListener('contextmenu', (e) => {
        if (e.target.closest('button, select, input, .taskbar-item, .desktop-preview, .desktop-preview-wrapper, .taskbar-usage')) return;
        e.preventDefault();
        e.stopPropagation();
        // re-dispatch onto the parent bar's handler for an identical menu
        bar.dispatchEvent(new MouseEvent('contextmenu', { clientX: e.clientX, clientY: e.clientY, bubbles: false, cancelable: true }));
      });
    }
  }

  _setupWelcome() {
    document.getElementById('welcome-new').addEventListener('click', () => this.showNewSessionDialog());
    document.getElementById('welcome-files').addEventListener('click', () => this.openFileExplorer());
    this._maybeShowOnboarding();
  }

  // ── First-run onboarding wizard ──
  // Shown once per browser when this instance has no sessions yet (fresh
  // container / new user). Guides: what VibeSpace is → connect Claude/Codex
  // (live install/login status + one-click login) → first session.
  async _maybeShowOnboarding() {
    if (localStorage.getItem('vs-onboarded')) return;
    let hasSessions = false;
    try {
      const d = await fetchJson('/api/sessions');
      hasSessions = (d.sessions || []).length > 0;
    } catch {}
    if (hasSessions) { localStorage.setItem('vs-onboarded', '1'); return; }
    this._showOnboarding();
  }

  // ── Shared modal shell for the config/password dialogs ──
  

  // ── Backup & migrate (one dialog, Export | Import tabs) ──
  // Merged into a single gs-menu entry after the menu grew too long.
  

  // Non-sensitive sections default-checked; sensitive items (password record,
  // agent CLI credentials) are opt-in and AES-encrypted under a passphrase.
  async _buildExportBody(body, close) {
    body.innerHTML = `<div class="ob-loading">${t('Checking…')}</div>`;
    let info;
    try { info = await fetchJson('/api/config/export-info'); }
    catch { body.innerHTML = `<p class="agents-note">${t('Failed to load export info.')}</p>`; return; }

    body.innerHTML = '';
    const mkRow = (id, label, desc, { checked = true, disabled = false } = {}) => {
      const row = document.createElement('label');
      row.className = 'cfg-row' + (disabled ? ' disabled' : '');
      row.innerHTML = `<input type="checkbox" data-sec="${id}" ${checked && !disabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <span class="cfg-row-text"><b>${escHtml(label)}</b><span>${escHtml(desc)}</span></span>`;
      return row;
    };
    const s = info.sections;
    const secWrap = document.createElement('div');
    secWrap.className = 'cfg-rows';
    secWrap.append(
      mkRow('settings', t('Settings'), t('{count} customized option(s), incl. Customize-UI arrangement', { count: s.settings.count })),
      mkRow('customThemes', t('Custom themes'), t('{count} theme(s)', { count: s.customThemes.count })),
      mkRow('layouts', t('Layouts & desktops'), t('{count} layout(s), {desktops} desktop(s), custom grids', { count: s.layouts.count, desktops: s.layouts.desktops })),
      mkRow('userState', t('Session metadata'), t('stars, renames, {groups} group(s), per-session configs', { groups: s.userState.groups })),
      mkRow('bookmarks', t('File bookmarks'), t('{count} bookmark(s)', { count: s.bookmarks.count })),
      mkRow('tasks', t('Task Groups'), t('{count} group(s) incl. backlogs & activity logs', { count: s.tasks?.count || 0 })),
      mkRow('pricing', t('Usage pricing table'), t('{count} model rate(s) / account discount(s)', { count: s.pricing?.count || 0 })),
      mkRow('clientPrefs', t('This browser’s preferences'), t('theme, font, language, usage-view choices')),
    );
    const sensHead = document.createElement('div');
    sensHead.className = 'cfg-sens-head';
    sensHead.innerHTML = `<b>${t('Sensitive')}</b><span> — ${t('off by default; encrypted with a passphrase. The file lets anyone who has it (and the passphrase) log in / use your agent accounts. Treat it like a key.')}</span>`;
    const sensWrap = document.createElement('div');
    sensWrap.className = 'cfg-rows cfg-rows-sens';
    sensWrap.append(
      mkRow('vsPassword', t('VibeSpace password'), info.sensitive.vsPassword ? t('password hash — same password works after import') : t('no password configured'), { checked: false, disabled: !info.sensitive.vsPassword }),
      mkRow('claudeCreds', t('Claude CLI credentials'), info.sensitive.claudeCreds ? t('~/.claude/.credentials.json — no re-login on the new instance') : t('not found on this machine'), { checked: false, disabled: !info.sensitive.claudeCreds }),
      mkRow('codexCreds', t('Codex CLI credentials'), info.sensitive.codexCreds ? '~/.codex/auth.json' : t('not found on this machine'), { checked: false, disabled: !info.sensitive.codexCreds }),
      mkRow('hosts', t('Remote hosts'), info.sensitive.hosts ? t('{n} ssh host(s) + uploaded keys', { n: info.sensitive.hosts }) : t('no hosts configured'), { checked: false, disabled: !info.sensitive.hosts }),
      mkRow('mounts', t('S3 mounts & shares'), info.sensitive.mounts ? t('{n} mount(s) incl. credentials', { n: info.sensitive.mounts }) : t('no mounts configured'), { checked: false, disabled: !info.sensitive.mounts }),
      mkRow('accounts', t('Billing accounts'), info.sensitive.accounts ? t('{n} account(s) — API keys + subscription logins', { n: info.sensitive.accounts }) : t('no accounts configured'), { checked: false, disabled: !info.sensitive.accounts }),
    );
    const passRow = document.createElement('div');
    passRow.className = 'cfg-pass-row hidden';
    passRow.innerHTML = `<label>${t('Encryption passphrase')} <input type="password" id="cfg-exp-pass" placeholder="${t('min 4 chars')}" autocomplete="new-password"></label>`;
    const syncPass = () => {
      const anySens = [...sensWrap.querySelectorAll('input:checked')].length > 0;
      passRow.classList.toggle('hidden', !anySens);
    };
    sensWrap.addEventListener('change', syncPass);

    const err = document.createElement('div'); err.className = 'cfg-err';
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn-create';
    exportBtn.textContent = t('Export');
    exportBtn.onclick = async () => {
      err.textContent = '';
      const sections = [...secWrap.querySelectorAll('input:checked')].map(i => i.dataset.sec);
      const includeSensitive = [...sensWrap.querySelectorAll('input:checked')].map(i => i.dataset.sec);
      const passphrase = passRow.querySelector('input')?.value || '';
      if (!sections.length && !includeSensitive.length) { err.textContent = t('Nothing selected'); return; }
      if (includeSensitive.length && passphrase.length < 4) { err.textContent = t('Passphrase must be at least 4 characters'); return; }
      const clientPrefs = {};
      for (const k of CLIENT_PREF_KEYS) {
        const v = localStorage.getItem(k);
        if (v != null) clientPrefs[k] = v;
      }
      try {
        const res = await fetch('/api/config/export', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sections, includeSensitive, passphrase, clientPrefs }),
        });
        if (!res.ok) { err.textContent = (await res.json().catch(() => ({}))).error || t('Export failed'); return; }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `vibespace-config-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        close();
        showToast(t('Configuration exported'));
      } catch { err.textContent = t('Export failed'); }
    };
    actions.appendChild(exportBtn);
    body.append(secWrap, sensHead, sensWrap, passRow, err, actions);
  }

  // File is inspected CLIENT-side (plain JSON; the sensitive manifest sits
  // outside the ciphertext) → user picks sections → server applies. Each
  // section REPLACES its store. Page reloads afterwards.
  _buildImportBody(body, close, presetFile = null) {
    const pick = document.createElement('div');
    pick.className = 'cfg-import-pick';
    pick.innerHTML = `<button class="btn-create" id="cfg-imp-pick">${t('Choose config file…')}</button><span class="agents-note">${t('a vibespace-config-*.json export')}</span>`;
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.accept = 'application/json,.json'; fileInput.style.display = 'none';
    body.append(pick, fileInput);
    pick.querySelector('#cfg-imp-pick').onclick = () => fileInput.click();

    const SEC_LABELS = {
      settings: [t('Settings'), (d) => t('{n} option(s)', { n: Object.keys(d).length })],
      customThemes: [t('Custom themes'), (d) => t('{n} theme(s)', { n: Object.keys(d || {}).length })],
      layouts: [t('Layouts & desktops'), (d) => t('{a} layout(s), {b} desktop(s)', { a: Object.keys(d?.layouts || {}).length, b: (d?.desktopMeta || []).length })],
      userState: [t('Session metadata'), (d) => t('{a} group(s), {b} rename(s), {c} star(s)', { a: Object.keys(d?.sessionGroups || {}).length, b: Object.keys(d?.customNames || {}).length, c: Object.keys(d?.starredSessions || {}).length })],
      bookmarks: [t('File bookmarks'), (d) => t('{n} bookmark(s)', { n: (d || []).length })],
      tasks: [t('Task Groups'), (d) => t('{n} group(s)', { n: (d?.tasks || []).length })],
      pricing: [t('Usage pricing table'), (d) => t('{n} model rate(s) / account discount(s)', { n: Object.keys(d?.tiers || {}).length + Object.keys(d?.accounts || {}).length })],
      clientPrefs: [t('Browser preferences'), (d) => Object.keys(d || {}).join(', ') || t('empty')],
    };
    const SENS_LABELS = { vsPassword: t('VibeSpace password'), claudeCreds: t('Claude CLI credentials'), codexCreds: t('Codex CLI credentials'), hosts: t('Remote hosts'), mounts: t('S3 mounts & shares'), accounts: t('Billing accounts') };

    const renderFile = (file) => {
      body.innerHTML = '';
      const head = document.createElement('p');
      head.className = 'agents-note';
      head.textContent = t('Exported {date} — each selected section REPLACES the current data.', { date: file.exportedAt ? new Date(file.exportedAt).toLocaleString() : t('(unknown date)') });
      const secWrap = document.createElement('div');
      secWrap.className = 'cfg-rows';
      for (const [id, data] of Object.entries(file.sections || {})) {
        const meta = SEC_LABELS[id];
        if (!meta) continue;
        const row = document.createElement('label');
        row.className = 'cfg-row';
        row.innerHTML = `<input type="checkbox" data-sec="${id}" checked>
          <span class="cfg-row-text"><b>${escHtml(meta[0])}</b><span>${escHtml(meta[1](data))}</span></span>`;
        secWrap.appendChild(row);
      }
      const sensWrap = document.createElement('div');
      sensWrap.className = 'cfg-rows cfg-rows-sens';
      const passRow = document.createElement('div');
      passRow.className = 'cfg-pass-row hidden';
      passRow.innerHTML = `<label>${t('Decryption passphrase')} <input type="password" autocomplete="off"></label>`;
      if (file.sensitive?.manifest?.length) {
        const sensHead = document.createElement('div');
        sensHead.className = 'cfg-sens-head';
        sensHead.innerHTML = `<b>${t('Sensitive (encrypted)')}</b><span> — ${t('requires the export passphrase')}</span>`;
        body.appendChild(sensHead);
        for (const id of file.sensitive.manifest) {
          const row = document.createElement('label');
          row.className = 'cfg-row';
          // SSO on → an imported password is redundant (login goes through the
          // IdP) and is ignored on the server; disable the row + say why.
          const pwIgnored = id === 'vsPassword' && this._ssoEnabled;
          const sub = id === 'vsPassword'
            ? (pwIgnored ? t('ignored — this instance uses SSO login') : t('enables password auth; all other devices are logged out'))
            : t('written to this machine');
          row.innerHTML = `<input type="checkbox" data-sec="${id}"${pwIgnored ? ' disabled' : ''}>
            <span class="cfg-row-text"><b>${escHtml(SENS_LABELS[id] || id)}</b><span>${sub}</span></span>`;
          if (pwIgnored) row.style.opacity = '0.55';
          sensWrap.appendChild(row);
        }
        sensWrap.addEventListener('change', () => {
          passRow.classList.toggle('hidden', !sensWrap.querySelector('input:checked'));
        });
      }
      const err = document.createElement('div'); err.className = 'cfg-err';
      const actions = document.createElement('div');
      actions.className = 'dialog-actions';
      const importBtn = document.createElement('button');
      importBtn.className = 'btn-create';
      importBtn.textContent = t('Import');
      importBtn.onclick = async () => {
        err.textContent = '';
        const sections = [...secWrap.querySelectorAll('input:checked')].map(i => i.dataset.sec);
        const includeSensitive = [...sensWrap.querySelectorAll('input:checked')].map(i => i.dataset.sec);
        const passphrase = passRow.querySelector('input')?.value || '';
        if (!sections.length && !includeSensitive.length) { err.textContent = t('Nothing selected'); return; }
        if (includeSensitive.length && !passphrase) { err.textContent = t('Enter the passphrase'); return; }
        try {
          const res = await fetch('/api/config/import', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file, sections, includeSensitive, passphrase }),
          });
          const d = await res.json().catch(() => ({}));
          if (!res.ok) { err.textContent = d.error || t('Import failed'); return; }
          if (d.clientPrefs) {
            for (const [k, v] of Object.entries(d.clientPrefs)) {
              if (CLIENT_PREF_KEYS.includes(k)) localStorage.setItem(k, v);
            }
          }
          close();
          showToast(t('Imported: {sections} — reloading…', { sections: d.applied.join(', ') }));
          setTimeout(() => location.reload(), 900);
        } catch { err.textContent = t('Import failed'); }
      };
      actions.appendChild(importBtn);
      body.append(head, secWrap, sensWrap, passRow, err, actions);
    };

    const readFile = (f) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const file = JSON.parse(reader.result);
          if (file.app !== 'vibespace-config') throw new Error('not a config');
          renderFile(file);
        } catch { body.querySelector('.agents-note').textContent = t('Not a valid VibeSpace config file.'); }
      };
      reader.readAsText(f);
    };
    fileInput.onchange = () => { if (fileInput.files[0]) readFile(fileInput.files[0]); };
    if (presetFile) readFile(presetFile);
  }

  // ── In-app password management ──
  // Setting/changing revokes every other device's token (this browser gets a
  // fresh one). Removing disables auth; env vars won't re-enable a user-set
  // state on the next boot.
  

  

  _refitAllTerminals() {
    for (const [, session] of this.sessions) {
      if (session.overrides && session.terminal) { // TerminalSession (ChatView has no .overrides)
        try { session.terminal.clearTextureAtlas(); } catch {}
        try { session.fit(); } catch {}
      }
    }
  }

  _setupGlobalSettings() {
    this._fontSize = parseInt(localStorage.getItem('termFontSize')) || 14;
    this._fontFamily = localStorage.getItem('termFontFamily') || getAvailableFonts()[0]?.value || 'monospace';
    this._settingsUI = new SettingsUI(this);
    this._customize = new CustomizeMode(this);

    const btn = document.getElementById('btn-global-settings');
    btn.onclick = (e) => { e.stopPropagation(); this._showGlobalSettings(btn); };
    // UI scale re-apply on viewport resize (review F9): applyUiPrefs only ran
    // at boot + gs-menu change, so crossing the 768px mobile boundary either
    // stranded the saved scale (narrow-at-boot) or left the zoom active under
    // the mobile CSS (wide→narrow, 100vw sidebar × zoom = overflow).
    // cheap stamp on EVERY resize frame — chat scroll handlers read it to
    // tell drag-resize displacement from user scrolling (2.339.1 incident:
    // moving/resizing the Chrome window froze the page on the old ungated
    // extends; the stamp keeps the new gates closed for the whole drag)
    window.addEventListener('resize', () => { try { window.__vsViewportResizeAt = Date.now(); } catch { } }, { passive: true });
    let uiRz = null;
    window.addEventListener('resize', () => {
      clearTimeout(uiRz);
      uiRz = setTimeout(() => {
        const before = uiScale();
        applyUiPrefs();
        if (uiScale() !== before) this._refitAllTerminals();
      }, 250);
    });
  }

  _showGlobalSettings(anchor) {
    const pop = createPopover(anchor, 'global-settings-popover');
    const rect = anchor.getBoundingClientRect();
    pop.style.left = '';
    pop.style.top = ((rect.bottom + 4) / uiScale()) + 'px';
    pop.style.right = ((window.innerWidth - rect.right) / uiScale()) + 'px';

    const opt = (v, l) => { const o = document.createElement('option'); o.value = v; o.textContent = l; return o; };

    // Theme
    const themeLabel = document.createElement('label'); themeLabel.textContent = t('Theme');
    const themeSel = document.createElement('select');
    themeSel.id = 'global-theme-select';
    this._populateThemeSelect(themeSel);
    themeSel.value = this.themeManager.current;
    themeSel.onchange = () => {
      this.themeManager.apply(themeSel.value);
      for (const [, session] of this.sessions) {
        if (session.updateTheme) session.updateTheme(this.themeManager.getTerminalTheme());
      }
    };

    // Theme editor button
    const editBtn = document.createElement('button');
    editBtn.className = 'file-tool-btn';
    editBtn.textContent = '\u270E';
    editBtn.title = t('Theme Editor');
    editBtn.onclick = (e) => { e.stopPropagation(); if (!this._themeEditor) this._themeEditor = new ThemeEditor(this); this._themeEditor.open(); };

    // Font size
    const sizeLabel = document.createElement('label'); sizeLabel.textContent = t('Font Size');
    const sizeRow = document.createElement('div'); sizeRow.className = 'font-size-ctrl';
    const sizeDown = document.createElement('button'); sizeDown.textContent = 'A-';
    const sizeVal = document.createElement('span'); sizeVal.textContent = this._fontSize;
    const sizeUp = document.createElement('button'); sizeUp.textContent = 'A+';
    sizeRow.append(sizeDown, sizeVal, sizeUp);

    const applyFontSize = () => {
      localStorage.setItem('termFontSize', this._fontSize);
      sizeVal.textContent = this._fontSize;
      for (const [, session] of this.sessions) {
        if (session._applyFontSize) {
          // ChatView
          session._applyFontSize(this._fontSize);
        } else if (session.overrides && !session.overrides.fontSize) {
          // TerminalSession
          session.terminal.options.fontSize = this._fontSize;
          try { session.terminal.clearTextureAtlas(); } catch {}
          session.fit();
        }
      }
    };
    sizeDown.onclick = () => { if (this._fontSize > 8) { this._fontSize--; applyFontSize(); } };
    sizeUp.onclick = () => { if (this._fontSize < 28) { this._fontSize++; applyFontSize(); } };

    // Font family
    const fontLabel = document.createElement('label'); fontLabel.textContent = t('Font');
    const fontSel = document.createElement('select');
    for (const f of getAvailableFonts()) {
      const o = opt(f.value === '_sep' ? '' : f.value, f.label);
      if (f.disabled) { o.disabled = true; o.style.fontSize = '9px'; o.style.color = 'var(--text-dim)'; }
      fontSel.appendChild(o);
    }
    fontSel.value = this._fontFamily;
    // A stored font that matches no option (stale localStorage, font list not
    // yet loaded, uninstalled font) left the select BLANK — surface it instead
    if (fontSel.selectedIndex === -1) {
      const curLabel = (this._fontFamily.split(',')[0] || t('Current')).replace(/"/g, '').trim() || t('Current');
      const cur = opt(this._fontFamily, t('{name} (current)', { name: curLabel }));
      fontSel.insertBefore(cur, fontSel.firstChild);
      fontSel.value = this._fontFamily;
    }
    fontSel.onchange = () => {
      this._fontFamily = fontSel.value;
      localStorage.setItem('termFontFamily', this._fontFamily);
      for (const [, session] of this.sessions) {
        if (!session.overrides) continue; // ChatView, not TerminalSession
        if (!session.overrides.fontFamily) {
          session.terminal.options.fontFamily = this._fontFamily;
          try { session.terminal.clearTextureAtlas(); } catch {}
          session.fit();
        }
      }
    };

    // UI scale (DPI) + UI font size — per-DEVICE like the language (a phone
    // and a 4K desktop viewing the same instance want different scales, so
    // these live in localStorage, never the synced settings store). Scale =
    // whole-app CSS zoom (terminals refit + atlas-clear on change; 100% keeps
    // them sharpest); font size = text-only multiplier on chrome labels
    // (sidebar/taskbar/desktop-preview names/menus) via --ui-font-scale.
    const mkPctRow = (labelText, key, min, max, onApply) => {
      const lab = document.createElement('label'); lab.textContent = labelText;
      const row = document.createElement('div'); row.className = 'font-size-ctrl';
      const down = document.createElement('button'); down.textContent = '\u2212';
      const val = document.createElement('span');
      const up = document.createElement('button'); up.textContent = '+';
      const cur = () => getUiPref(key);
      const render = () => { val.textContent = cur() + '%'; };
      const set = (v) => {
        const nv = Math.max(min, Math.min(max, v));
        if (nv === 100) localStorage.removeItem(key); else localStorage.setItem(key, String(nv));
        render(); applyUiPrefs(); onApply?.();
      };
      down.onclick = () => set(cur() - 5);
      up.onclick = () => set(cur() + 5);
      val.style.cursor = 'pointer'; val.title = t('Click to reset to 100%');
      val.onclick = () => set(100);
      render();
      row.append(down, val, up);
      return [lab, row];
    };
    const [scaleLab, scaleRow] = mkPctRow(t('UI scale (DPI)'), 'vibespace.uiScale', UI_SCALE_MIN, UI_SCALE_MAX, () => this._refitAllTerminals());
    const [fscaleLab, fscaleRow] = mkPctRow(t('UI font size'), 'vibespace.uiFontScale', UI_FONT_MIN, UI_FONT_MAX);

    // "All Settings" link
    const allSettingsLink = document.createElement('div');
    allSettingsLink.className = 'settings-all-link';
    allSettingsLink.textContent = t('All Settings...');
    allSettingsLink.onclick = () => { pop.remove(); this._settingsUI.open(); };

    const themeRow = document.createElement('div');
    themeRow.style.cssText = 'display:flex;align-items:center;gap:4px';
    themeRow.append(themeSel, editBtn);
    pop.append(themeLabel, themeRow, sizeLabel, sizeRow, fontLabel, fontSel, scaleLab, scaleRow, fscaleLab, fscaleRow, allSettingsLink);

    // Account / help section — the 'gear' MENU REGISTRY (gear-menu.js holds
    // the core rows as contributions; a plugin adds rows through the same
    // registerMenuItem({ menu: 'gear', … }) call). Mobile shares this menu.
    pop.append(buildGearMenu(this, pop));
  }

  // Update-confirm dialog: every changelog entry between the RUNNING version
  // and the canonical repo's latest, then an explicit "Update now".
  async _showUpdateConfirmDialog() {
    const { body, close } = createModalShell({ id: 'update-confirm-dialog', title: t('Update VibeSpace'), bodyClass: 'update-confirm-body', minWidth: 'min(560px, 92vw)', escapeToClose: true });
    body.innerHTML = `<div class="empty-hint">${t('Checking for updates\u2026')}</div>`;
    const [v, cl] = await Promise.all([fetchJson('/api/version?fresh=1'), fetchJson('/api/changelog-diff?fresh=1')]);
    if (!body.isConnected) return;
    const cur = v?.version || cl?.current || '?';
    const entries = cl?.entries || [];
    // /api/version's `latest` and the changelog are fetched+cached SEPARATELY —
    // their stamps can disagree (real report: badge said "latest" while the
    // list showed the next version's entries). The newest changelog entry
    // carries a version too; trust whichever source is newer.
    const newestEntry = entries[0]?.version || null;
    let latest = v?.latest || cl?.latest || null;
    if (newestEntry && (!latest || this._versionNewer(newestEntry, latest))) latest = newestEntry;
    const newer = latest && this._versionNewer(latest, cur);
    const atLatest = !newer;
    const list = entries.length
      ? entries.map((e) => `
        <div class="ucl-entry">
          <div class="ucl-ver">v${escHtml(e.version)}</div>
          <pre class="ucl-body">${escHtml(e.body || '')}</pre>
        </div>`).join('')
      : `<div class="empty-hint">${t('No changelog details available.')}</div>`;
    // Already on latest: show the current version's own changelog (server
    // returns it) under a "what's in this version" heading (user request).
    body.innerHTML = `
      <div class="ucl-head">${escHtml(newer ? `v${cur} \u2192 v${latest}` : `v${cur}`)}${
        newer ? `<span class="gs-ver-new ucl-newtag">${t('Update available')}</span>`
              : `<span class="ucl-newtag ucl-latesttag">${t('Latest version')}</span>`}</div>
      ${atLatest && entries.length ? `<div class="ucl-sub">${t('What’s in this version:')}</div>` : ''}
      <div class="ucl-list">${list}</div>
      <div class="dialog-actions">
        <button type="button" class="mounts-btn" data-act="cancel">${t('Close')}</button>
        <button type="button" class="btn-create" data-act="go">${newer ? t('Update now') : t('Re-run update')}</button>
      </div>`;
    body.querySelector('[data-act=cancel]').onclick = () => close();
    body.querySelector('[data-act=go]').onclick = () => {
      close();
      this._runSelfUpdate();
    };
  }

  // UI-driven self-update (user directive: no more "terminal opens, runs for
  // a while, then just sits there"). The update runs as a detached server op;
  // this dialog streams its log, survives the service restart by polling
  // /api/version, and reloads the page once the new version answers.
  async _runSelfUpdate() {
    const { body } = createModalShell({ id: 'self-update-dialog', title: t('Updating VibeSpace') });
    body.innerHTML = `
      <div class="selfupd-phase"><span class="upload-active-spinner"></span><span class="su-msg">${escHtml(t('Starting update…'))}</span></div>
      <pre class="selfupd-log"></pre>
      <div class="mounts-field-hint">${escHtml(t('Sessions keep running (dtach) — the page reloads by itself when the new version is up.'))}</div>
      <div class="dialog-actions"><button type="button" class="mounts-btn su-reload" style="display:none">${escHtml(t('Reload now'))}</button></div>`;
    const phaseEl = body.querySelector('.su-msg');
    const spinEl = body.querySelector('.upload-active-spinner');
    const logEl = body.querySelector('.selfupd-log');
    const reloadBtn = body.querySelector('.su-reload');
    reloadBtn.onclick = () => location.reload();
    const setPhase = (msg, cls) => { phaseEl.textContent = msg; if (cls) { phaseEl.className = 'su-msg ' + cls; spinEl?.remove(); } };
    const ver = () => fetchJson('/api/version?t=' + Date.now()); // cache-bust so a restart is actually observed
    const startVersion = (await ver())?.version || null;
    const r = await fetchJson('/api/self-update', { method: 'POST' });
    if (!r?.success) { setPhase(r?.error || t('Failed'), 'ob-bad'); return; }
    const t0 = Date.now();
    let done = false, wasDown = false, restartSeen = false;
    const reload = (msg) => { done = true; setPhase(msg, 'ob-ok'); setTimeout(() => location.reload(), 1200); };
    const tick = async () => {
      if (done || !body.isConnected) return;
      const st = await fetchJson('/api/self-update/status');
      const v = await ver();
      if (st?.log) {
        logEl.textContent = st.log.replace(/__UPDATE_EXIT:\d+\s*$/, '');
        logEl.scrollTop = logEl.scrollHeight;
        if (/restarting/i.test(st.log)) restartSeen = true;
      }
      const exitM = /__UPDATE_EXIT:(\d+)/.exec(st?.log || '');
      // Failure first — a non-zero exit means the build/pull broke; stop.
      if (exitM && exitM[1] !== '0') {
        done = true; setPhase(t('Update failed (exit {code}) — see the log below', { code: exitM[1] }), 'ob-bad');
        reloadBtn.style.display = ''; return;
      }
      // The server going unreachable then reachable again IS the restart —
      // the robust signal that new code is serving (works even when the
      // version number is unchanged, e.g. re-running update on the latest).
      if (!v) { wasDown = true; setPhase(t('Restarting the service…')); }
      else if (startVersion && v.version !== startVersion) { reload(t('Updated to v{v} — reloading…', { v: v.version })); return; }
      else if (v && (wasDown || (restartSeen && exitM && exitM[1] === '0'))) { reload(t('Update complete — reloading…')); return; }
      // Finished, exit 0, but no restart happened at all (no service manager
      // branch of update.sh) — nothing to reload onto; just confirm.
      else if (exitM && exitM[1] === '0' && !restartSeen && Date.now() - t0 > 8000) {
        done = true; setPhase(t('Already up to date (v{v})', { v: v?.version || startVersion }), 'ob-ok'); return;
      }
      if (Date.now() - t0 > 10 * 60 * 1000) {
        done = true; setPhase(t('Timed out — check the log below or data/update.log on the server'), 'ob-bad');
        reloadBtn.style.display = ''; return;
      }
      setTimeout(tick, 900);
    };
    tick();
  }
  /** Is semver a newer than b? (plain x.y.z compare) */
  _versionNewer(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return true;
      if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
  }

  _setupGridConfig() {
    const rowsInput = document.getElementById('grid-rows');
    const colsInput = document.getElementById('grid-cols');
    const preview = document.getElementById('grid-preview');

    const updatePreview = () => {
      const r = parseInt(rowsInput.value) || 2, c = parseInt(colsInput.value) || 2;
      preview.style.gridTemplateRows = `repeat(${r}, 1fr)`;
      preview.style.gridTemplateColumns = `repeat(${c}, 1fr)`;
      preview.innerHTML = '';
      for (let i = 0; i < r * c; i++) {
        const cell = document.createElement('div'); cell.className = 'grid-preview-cell'; cell.textContent = i + 1;
        preview.appendChild(cell);
      }
    };

    document.getElementById('btn-add-grid').addEventListener('click', () => {
      updatePreview();
      this._showDialog('dialog-grid');
    });
    rowsInput.addEventListener('input', updatePreview);
    colsInput.addEventListener('input', updatePreview);

    document.getElementById('btn-apply-grid').addEventListener('click', () => {
      const r = parseInt(rowsInput.value) || 2, c = parseInt(colsInput.value) || 2;
      this._addCustomGrid(r, c);
      this.hideDialogs();
    });

    // Load saved custom grids on startup
    this._loadCustomGrids();
  }

  _gridIcon(rows, cols) {
    // For grids up to 4x4, render SVG cells; otherwise show "RxC" text
    if (rows * cols > 16) {
      return `<span style="font-size:9px;font-weight:600;line-height:14px">${rows}x${cols}</span>`;
    }
    const gap = 1, size = 16;
    const cw = (size - gap * (cols + 1)) / cols;
    const ch = (size - gap * (rows + 1)) / rows;
    const sw = Math.min(1.2, 14 / (rows * cols + 4));
    let rects = '';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = gap + c * (cw + gap), y = gap + r * (ch + gap);
        rects += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cw.toFixed(1)}" height="${ch.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="${sw}"/>`;
      }
    }
    return `<svg viewBox="0 0 16 16" width="14" height="14">${rects}</svg>`;
  }

  _renderCustomGridButton(rows, cols) {
    const btn = document.createElement('button');
    btn.className = 'layout-btn custom-grid-btn';
    btn.title = t('{rows}×{cols} grid', { rows, cols });
    btn.innerHTML = this._gridIcon(rows, cols);
    btn.dataset.gridRows = rows;
    btn.dataset.gridCols = cols;
    btn.onclick = () => this.wm.applyLayout(`grid-${rows}-${cols}`);
    // Register this grid size in window manager
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      this._removeCustomGrid(rows, cols);
    };
    return btn;
  }

  async _loadCustomGrids() {
    const data = await fetchJson('/api/layouts');
    this._customGrids = data?.customGrids || [];
    this._renderCustomGridButtons();
  }

  _renderCustomGridButtons() {
    const container = document.getElementById('custom-grids-container');
    container.innerHTML = '';
    for (const g of this._customGrids || []) {
      container.appendChild(this._renderCustomGridButton(g.rows, g.cols));
    }
  }

  async _addCustomGrid(rows, cols) {
    // Apply grid immediately
    this.wm.setGrid(rows, cols);
    // Check if it's a built-in preset — don't save those
    const builtins = [[1,1],[1,2],[2,1],[2,2],[1,3]];
    if (builtins.some(([r,c]) => r === rows && c === cols)) return;
    // Save to server. A dropped failure silently never created the button and
    // the "saved" preset was gone on the next load.
    try {
      const data = await api('/api/custom-grids', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, cols }),
      });
      this._customGrids = data?.customGrids || [];
      this._renderCustomGridButtons();
    } catch (e) {
      showToast(t('Could not save the grid preset — {reason}', { reason: e?.message || t('server unreachable') }), { type: 'error' });
    }
  }

  async _removeCustomGrid(rows, cols) {
    try {
      const data = await api('/api/custom-grids', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, cols }),
      });
      this._customGrids = data?.customGrids || [];
      this._renderCustomGridButtons();
    } catch (e) {
      showToast(t('Could not remove the grid preset — {reason}', { reason: e?.message || t('server unreachable') }), { type: 'error' });
    }
  }

  // Command mode extracted to CommandMode class (src/lib/command-mode.js)

  _setupLayoutManager() {
    document.getElementById('btn-presets').addEventListener('click', () => this._showPresetsDialog());
    document.getElementById('btn-preset-save').addEventListener('click', () => {
      const input = document.getElementById('preset-save-name');
      const name = input.value.trim();
      if (!name) return;
      this.layoutManager.savePreset(name).then(() => {
        input.value = '';
        this._renderPresetsList();
      });
    });
  }

  async _showPresetsDialog() {
    await this.layoutManager.refresh();
    this._renderPresetsList();
    this._showDialog('dialog-presets');
  }

  _renderPresetsList() {
    const list = document.getElementById('saved-presets-list');
    list.innerHTML = '';
    const presets = this.layoutManager._savedPresets;
    const names = Object.keys(presets).sort();
    if (!names.length) {
      list.innerHTML = `<div class="empty-hint">${t('No saved presets. Save current workspace as a preset.')}</div>`;
      return;
    }
    for (const name of names) {
      const preset = presets[name];
      const card = document.createElement('div'); card.className = 'layout-card';
      const isCurrent = name === this.layoutManager._currentName;

      const info = document.createElement('div'); info.className = 'layout-card-info';
      info.innerHTML = `<div class="layout-card-name">${isCurrent ? '● ' : ''}${escHtml(name)}</div>
        <div class="layout-card-meta">${t('{n} windows', { n: preset.windows?.length || 0 })} · ${escHtml(preset.theme || 'dark')} · ${preset.updatedAt ? new Date(preset.updatedAt).toLocaleString() : ''}</div>`;
      info.onclick = () => {
        this.layoutManager.loadPreset(name).then(() => this.hideDialogs());
      };

      const actions = document.createElement('div'); actions.className = 'layout-card-actions';
      const btnOverwrite = document.createElement('button'); btnOverwrite.className = 'layout-card-btn'; btnOverwrite.textContent = '⟳';
      btnOverwrite.title = t('Overwrite with current');
      btnOverwrite.onclick = (e) => { e.stopPropagation(); this.layoutManager.savePreset(name).then(() => this._renderPresetsList()); };
      const btnDel = document.createElement('button'); btnDel.className = 'layout-card-btn delete'; btnDel.textContent = '✕';
      btnDel.title = t('Delete');
      btnDel.onclick = (e) => { e.stopPropagation(); this.layoutManager.deletePreset(name).then(() => this._renderPresetsList()); };
      actions.append(btnOverwrite, btnDel);

      card.append(info, actions);
      list.appendChild(card);
    }
  }

  _setupDialogs() {
    const overlay = document.getElementById('dialog-overlay');
    overlay.querySelectorAll('.dialog-close, .btn-cancel').forEach(btn => btn.addEventListener('click', () => this.hideDialogs()));
    // Close on backdrop click — but ONLY when the interaction STARTED on the
    // backdrop (inc-mtd1c2sd "我选中个东西结果对话框没了": a text-selection
    // drag that begins inside an input and releases outside fires the click
    // on the common ancestor = the overlay, and the whole dialog vanished
    // mid-form; createModalShell keys on mousedown and is immune).
    let _downOnOverlay = false;
    overlay.addEventListener('mousedown', (e) => { _downOnOverlay = e.target === overlay; });
    overlay.addEventListener('click', (e) => { if (e.target === overlay && _downOnOverlay) this.hideDialogs(); });

    // Global Escape: close the transient chrome layer-by-layer — context menus
    // and popovers first, then the modal dialog. Skipped while focus is inside
    // a terminal (Esc is meaningful to TUI apps there).
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      if (e.target.closest?.('.xterm')) return;
      const floats = document.querySelectorAll('[data-popover]');
      if (floats.length) { floats.forEach(el => el.remove()); e.preventDefault(); return; }
      if (!overlay.classList.contains('hidden')) { this.hideDialogs(); e.preventDefault(); }
    });

    const backendInput = document.getElementById('input-backend');
    backendInput.addEventListener('change', () => this._applySessionBackendOptions(backendInput.value, { applyDefaults: true }));
    this._applySessionBackendOptions(backendInput.value || 'claude', { applyDefaults: true });

    // Enter in any text input of the New Session dialog submits it
    document.getElementById('dialog-new-session').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      if (e.target.tagName !== 'INPUT') return;
      // Let the cwd autocomplete accept its highlighted suggestion first
      if (e.target.id === 'input-cwd' && !document.getElementById('cwd-suggestions')?.classList.contains('hidden')) return;
      e.preventDefault();
      document.querySelector('#dialog-new-session .btn-create').click();
    });

    document.querySelector('#dialog-new-session .btn-create').addEventListener('click', async (ev) => {
      const createBtn = ev.currentTarget;
      if (createBtn.dataset.busy) return; // Enter + click racing the async check
      const backend = document.getElementById('input-backend').value || 'claude';
      const hostId = document.getElementById('input-host')?.value || undefined;
      const cwd = document.getElementById('input-cwd').value.trim();
      // A typo'd/nonexistent cwd used to fail opaquely at spawn time (pty chdir
      // error → instant "terminated"; remote silently fell back to $HOME).
      // Stat it first and offer to create the folder; on cancel the dialog
      // stays open for correction.
      if (cwd) {
        createBtn.dataset.busy = '1';
        const ok = await this._ensureCwdExists(cwd, hostId).finally(() => delete createBtn.dataset.busy);
        if (!ok) return;
      }
      if (backend === 'shell') {
        // Plain terminal — reuse openShellTerminal (handles host + defaults)
        this.openShellTerminal(cwd || undefined, { hostId });
        this.hideDialogs();
        return;
      }
      this.createSession({
        backend,
        hostId,
        mode: document.getElementById('input-mode').value,
        cwd,
        name: document.getElementById('input-session-name').value.trim(),
        model: document.getElementById('input-model').value === '__custom__'
          ? (document.getElementById('input-model-custom').value.trim() || '')
          : document.getElementById('input-model').value,
        permission: document.getElementById('input-permission').value,
        effort: document.getElementById('input-effort').value,
        extraArgs: document.getElementById('input-extra-args').value.trim(),
        taskId: document.getElementById('input-task')?.value || undefined,
        accountId: document.getElementById('input-account')?.value || undefined,
      });
      this.hideDialogs();
    });

    // Fork dialog: textarea + "Fork & Send". Sending a first message is what
    // makes the fork actually diverge (claude only mints the fork's new id once
    // it receives input), so the primary action requires non-empty text.
    const forkTa = document.getElementById('fork-first-message');
    const forkBtn = document.getElementById('btn-fork-send');
    if (forkTa && forkBtn) {
      const sync = () => { forkBtn.disabled = !forkTa.value.trim(); };
      forkTa.addEventListener('input', sync);
      forkBtn.addEventListener('click', () => {
        const text = forkTa.value.trim();
        if (!text || !this._pendingFork) return;
        const titleInput = document.getElementById('fork-title');
        const customName = titleInput ? titleInput.value.trim() : '';
        const info = this._pendingFork; const at = this._pendingForkAt;
        this._pendingFork = null; this._pendingForkAt = null;
        this.hideDialogs();
        this._doForkSession(info, text, at, customName);
      });
      forkTa.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); forkBtn.click(); }
      });
    }

    // CWD autocomplete
    this._setupCwdAutocomplete();
  }

  getSessionOptions(backend) {
    return BACKEND_SESSION_OPTIONS[backend] || BACKEND_SESSION_OPTIONS.claude;
  }

  _getBackendSessionDefaults(backend) {
    const prefix = settingsPrefixFor(backend);
    const cfg = BACKEND_SESSION_OPTIONS[backend] || BACKEND_SESSION_OPTIONS.claude;
    const legacyEffort = this.settings.get('session.defaultEffort') ?? '';
    let effort = this.settings.get(`${prefix}.defaultEffort`) ?? '';
    if (!effort && !this.settings.isModified(`${prefix}.defaultEffort`) && cfg.efforts.some((opt) => opt.value === legacyEffort)) {
      effort = legacyEffort;
    }
    return {
      model: this.settings.get(`${prefix}.defaultModel`) ?? '',
      permission: this.settings.get(`${prefix}.defaultPermissionMode`) ?? '',
      effort,
      extraArgs: this.settings.get(`${prefix}.defaultExtraArgs`) ?? '',
    };
  }

  _applySessionBackendOptions(backend, { applyDefaults = false } = {}) {
    // Plain shell terminal has no model/permission/effort/mode — hide those
    // rows so the dialog is just Backend / Host / Working Directory / Name.
    const isShell = backend === 'shell';
    for (const [id, hide] of [
      ['row-mode', isShell], ['row-model', isShell], ['custom-model-row', isShell],
      ['row-permission', isShell], ['row-effort', isShell || BACKEND_META[backend]?.caps?.effort === false], ['row-extra-args', isShell],
    ]) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', hide);
    }
    if (isShell) return; // nothing else to populate

    const cfg = BACKEND_SESSION_OPTIONS[backend] || BACKEND_SESSION_OPTIONS.claude;
    const modelSel = document.getElementById('input-model');
    const customModelRow = document.getElementById('custom-model-row');
    const customModelInput = document.getElementById('input-model-custom');
    const permissionSel = document.getElementById('input-permission');
    const effortSel = document.getElementById('input-effort');
    const extraArgsInput = document.getElementById('input-extra-args');
    const defaults = this._getBackendSessionDefaults(backend);
    const currentModel = modelSel?.value || '';
    const currentPermission = permissionSel?.value || '';
    const currentEffort = effortSel?.value || '';

    modelSel.innerHTML = '';
    const modelIds = [];
    for (const m of cfg.models) {
      const opt = document.createElement('option');
      const id = typeof m === 'string' ? m : m.id;
      const label = typeof m === 'string' ? (m || t('Default')) : (m.label || m.id || t('Default'));
      opt.value = id;
      opt.textContent = label;
      modelSel.appendChild(opt);
      modelIds.push(id);
    }
    // "Custom..." option for free-text model entry
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = t('Custom…');
    modelSel.appendChild(customOpt);

    const nextModel = applyDefaults
      ? defaults.model
      : (modelIds.includes(currentModel) ? currentModel : defaults.model);
    modelSel.value = modelIds.includes(nextModel) ? nextModel : '';

    // Wire custom model toggle
    modelSel.onchange = () => {
      const isCustom = modelSel.value === '__custom__';
      customModelRow.classList.toggle('hidden', !isCustom);
      if (isCustom && customModelInput) customModelInput.focus();
    };
    customModelRow.classList.add('hidden');

    permissionSel.innerHTML = '';
    for (const optData of cfg.permissions) {
      const opt = document.createElement('option');
      opt.value = optData.value;
      opt.textContent = optData.label;
      permissionSel.appendChild(opt);
    }
    const permissionValue = applyDefaults
      ? defaults.permission
      : (cfg.permissions.some((opt) => opt.value === currentPermission) ? currentPermission : defaults.permission);
    permissionSel.value = cfg.permissions.some((opt) => opt.value === permissionValue) ? permissionValue : '';

    effortSel.innerHTML = '';
    for (const optData of cfg.efforts) {
      const opt = document.createElement('option');
      opt.value = optData.value;
      opt.textContent = optData.label;
      effortSel.appendChild(opt);
    }

    const effortValue = applyDefaults
      ? defaults.effort
      : (cfg.efforts.some((opt) => opt.value === currentEffort) ? currentEffort : defaults.effort);
    effortSel.value = cfg.efforts.some((opt) => opt.value === effortValue) ? effortValue : '';

    if (extraArgsInput && applyDefaults) extraArgsInput.value = defaults.extraArgs || '';
  }

  _setupCwdAutocomplete() {
    const input = document.getElementById('input-cwd');
    const dropdown = document.getElementById('cwd-suggestions');
    // When a host is chosen, completion + recent chips come from that host
    // over ssh instead of the local filesystem.
    setupDirAutocomplete(input, dropdown, {
      endpoint: () => {
        const h = document.getElementById('input-host')?.value;
        return h ? `/api/hosts/${h}/dir-complete` : null;
      },
      // #2: float the selected task's linked folders to the top of the cwd
      // suggestions (highlighted), so starting a session "in" a task recommends
      // its own folders first.
      priorityPaths: () => {
        const tid = document.getElementById('input-task')?.value;
        const t = tid && this.sidebar?._taskById?.(tid);
        return t ? this.sidebar._folderPaths(t) : [];
      },
    });
  }

  // The selected Task Group's folder suggestions for the New Session dialog
  // chips: every linked folder, plus — for recursive folders — nested folders
  // that already contain sessions (e.g. group folder /a with sessions at /a
  // and /a/too ⇒ suggest BOTH /a and /a/too). Subfolder discovery is local
  // sessions only; with a remote host selected we still pin the folder paths
  // themselves (remote cwds aren't reliably in _allSessions).
  _taskCwdSuggestions(hostId) {
    const tid = document.getElementById('input-task')?.value;
    const tg = tid ? this.sidebar?._taskById?.(tid) : null;
    if (!tg) return [];
    const out = []; const seen = new Set();
    const add = (path, tip) => { if (path && !seen.has(path)) { seen.add(path); out.push({ path, tip, color: tg.color || '' }); } };
    for (const f of tg.folders || []) {
      const rec = this.sidebar._folderRec(f);
      add(rec.path, t('Task Group folder ({name})', { name: tg.title }));
      if (rec.recursive && !hostId) {
        const subs = new Map(); // session cwd strictly under the folder -> count
        for (const s of this.sidebar?._allSessions || []) {
          if (s.host || !s.cwd) continue;
          const under = s.cwd.startsWith(rec.path + '/') || (s.realCwd && s.realCwd.startsWith(rec.path + '/'));
          if (under) subs.set(s.cwd, (subs.get(s.cwd) || 0) + 1);
        }
        for (const [c, n] of [...subs.entries()].sort((a, b) => b[1] - a[1]))
          add(c, t('In a Task Group folder — {n} session(s) here', { n }));
      }
    }
    return out;
  }

  // Fill the recent-cwd chip row for the selected host (or local). The
  // selected Task Group's folders are PINNED first as marked chips.
  _fillCwdRecent(hostId) {
    const recentEl = document.getElementById('cwd-recent');
    if (!recentEl) return;
    const taskChips = this._taskCwdSuggestions(hostId);
    const paint = (cwds) => {
      recentEl.innerHTML = '';
      const mkChip = (cwd, { cls, tip, color } = {}) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'cwd-recent-chip' + (cls ? ' ' + cls : '');
        const short = cwd.replace(/^\/home\/[^/]+/, '~');
        if (cls) {
          if (color) { const dot = document.createElement('span'); dot.className = 'tvg-dot'; dot.style.setProperty('--g-color', color); chip.appendChild(dot); }
          const p = document.createElement('span'); p.className = 'cwd-chip-path'; p.textContent = short; chip.appendChild(p);
        } else {
          chip.textContent = short;
        }
        chip.title = tip ? `${tip}\n${cwd}` : cwd;
        chip.onclick = () => { document.getElementById('input-cwd').value = cwd; };
        recentEl.appendChild(chip);
      };
      for (const s of taskChips) mkChip(s.path, { cls: 'cwd-task-chip', tip: s.tip, color: s.color });
      const pinned = new Set(taskChips.map((s) => s.path));
      for (const cwd of cwds.filter((c) => !pinned.has(c)).slice(0, 8)) mkChip(cwd);
    };
    const stillThisHost = () => (document.getElementById('input-host')?.value || '') === (hostId || '');
    if (hostId) {
      recentEl.innerHTML = `<span class="cwd-recent-loading">${t('loading host paths…')}</span>`;
      // Show the DEVICE/remote home as the empty-cwd hint (B-0d70: the
      // placeholder used to stay the LOCAL home, so a paired Mac showed
      // /home/<user> which doesn't exist there). Reset to a NEUTRAL hint
      // BEFORE the async fetch so an offline/paired device whose /api/home
      // 400s never leaves the stale local home showing (review).
      const cwdInput = document.getElementById('input-cwd');
      if (cwdInput) cwdInput.placeholder = t('directory on this machine…');
      if (cwdInput) fetchJson(`/api/home?host=${encodeURIComponent(hostId)}`).then(d => {
        if (d?.home && stillThisHost()) cwdInput.placeholder = d.home;
      }).catch(() => {});
      fetchJson(`/api/hosts/${hostId}/recent-cwds`).then(d => {
        // GUARD: if the user switched hosts while this was in flight, don't
        // paint another host's REMOTE paths over the current selection
        // (review: a clicked chip would set a cross-host cwd).
        if (!stillThisHost()) return;
        // strip the "host: " display prefix discovery may add
        paint((d?.cwds || []).map(c => c.includes(': ') ? c.split(': ').pop() : c));
      }).catch(() => { if (stillThisHost()) recentEl.innerHTML = ''; });
    } else {
      const cwdInput = document.getElementById('input-cwd');
      if (cwdInput && this._localHome) cwdInput.placeholder = this._localHome;
      const seen = new Set();
      const local = [];
      for (const s of [...(this.sidebar?._allSessions || [])].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))) {
        if (!s.cwd || s.host || seen.has(s.cwd)) continue; // skip remote sessions' host-prefixed cwds
        seen.add(s.cwd); local.push(s.cwd);
        if (local.length >= 8) break;
      }
      paint(local);
    }
  }

  _showDialog(id) {
    // Mobile: #dialog-overlay sits BELOW the full-screen sidebar — every
    // index.html dialog opened from the sidebar was invisible (fork/new-session
    // patched this per-site before; central now).
    if (this.isMobile && this.sidebar?.isOpen) this.sidebar.toggle(false);
    const overlay = document.getElementById('dialog-overlay'); overlay.classList.remove('hidden');
    overlay.querySelectorAll('.dialog').forEach(d => d.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
  }

  showNewSessionDialog({ cwd, backend, hostId, taskId } = {}) {
    if (this.isMobile) this.sidebar.toggle(false); // close sidebar so dialog is visible
    this._showDialog('dialog-new-session');
    // Task dropdown — new sessions can start "in" a task: pre-selected when
    // opened from the task board, freely pickable otherwise. Picking a task
    // prefills the cwd from its first auto-include folder (never clobbers a
    // path the user already typed); the created session is bound to the task
    // and spawned with VIBESPACE_TASK_ID.
    const taskSel = document.getElementById('input-task');
    if (taskSel) {
      taskSel.innerHTML = `<option value="">${t('None')}</option>`;
      for (const tg of this.sidebar?._taskBoardOrder?.() || []) {
        const o = document.createElement('option');
        o.value = tg.id;
        o.textContent = tg.title + (tg.archived ? ' ' + t('(archived)') : '');
        taskSel.appendChild(o);
      }
      taskSel.value = taskId || '';
      taskSel.onchange = () => {
        const tg = this.sidebar?._taskById?.(taskSel.value);
        const cwdInput = document.getElementById('input-cwd');
        const firstFolder = tg?.folders?.[0] && (typeof tg.folders[0] === 'string' ? tg.folders[0] : tg.folders[0].path);
        if (firstFolder && !cwdInput.value.trim()) cwdInput.value = firstFolder;
        // Re-render the quick-fill chips — the group's folders pin to the front
        this._fillCwdRecent(document.getElementById('input-host')?.value || '');
      };
    }
    // Account dropdown (billing identity: subscription OAuth vs an API key).
    // Claude sessions only — remote hosts supported too (the key ships to the
    // remote over ssh stdin, never argv; 'Subscription' there means the
    // REMOTE machine's own login).
    const acctRow = document.getElementById('row-account');
    const acctSel = document.getElementById('input-account');
    const updateAcctRow = () => {
      if (!acctRow || !acctSel) return;
      const be = document.getElementById('input-backend')?.value || 'claude';
      const all = this._accounts?.accounts || [];
      const list = all.filter(a => (a.backend || 'claude') === be)
        // TYPE-then-name order, matching the Manage-Agents roster (2.268.5)
        .sort((a, b) => (((a.pooled || a.type === 'pooled') ? 0 : a.type === 'subscription' ? 1 : 2)
          - ((b.pooled || b.type === 'pooled') ? 0 : b.type === 'subscription' ? 1 : 2))
          || String(a.name || '').localeCompare(String(b.name || '')));
      const onHost = !!document.getElementById('input-host')?.value;
      const show = (be === 'claude' || be === 'codex') && list.length > 0;
      acctRow.style.display = show ? '' : 'none';
      if (!show) { acctSel.value = ''; return; }
      const defId = be === 'codex' ? this._accounts?.defaultCodexAccountId : this._accounts?.defaultAccountId;
      const globalLabel = be === 'codex' ? t('ChatGPT login') : t('Subscription');
      const defName = defId ? (list.find(a => a.id === defId)?.name || t('API key')) : globalLabel;
      const prev = acctSel.value;
      acctSel.innerHTML = '';
      const hostId = document.getElementById('input-host')?.value || '';
      const hostRec = hostId ? (this._nsHosts || this.sidebar?._hostsData?.hosts || []).find(h => h.id === hostId) : null;
      const hostName = hostRec?.name || hostId;
      const cliLoginLabel = be === 'codex'
        ? (onHost ? t('ChatGPT login (on the host)') : t('ChatGPT login'))
        : (onHost ? t('CLI login') + ' @ ' + hostName + ' (Pro/Max)' : t('Subscription (Pro/Max login)'));
      const opts = [
        ['', t('Default ({name})', { name: defName })],
        ['subscription', cliLoginLabel], // the CLI's global login (on the host for remote sessions)
      ];
      // Subscription accounts for a REMOTE host — SAME semantics as the billing
      // switcher (2.198.0/2.199.0; userN's bootloop started here: the dialog
      // hid every named subscription for remote, forcing create-then-switch on
      // an empty session): email-LINKED to the host's own login or HELD on the
      // host (per-host login dir) = usable with zero creds shipped; otherwise
      // shipping needs the opt-in toggle (ban risk, default OFF; never dial).
      // API keys always ship. Local: needs a local login.
      const allowSubRemote = !!this.settings?.get?.('accounts.shipSubscriptionToRemote');
      const hostOwnEmail = onHost && be !== 'codex'
        ? String(this._hostOwnUsage?.[hostId]?.orgEmail || this._hostUsage?.[hostId]?.orgEmail || '').trim().toLowerCase() : '';
      const emailOf = (a) => String(this._accountUsage?.[a.id]?.orgEmail || a.email || (String(a.name || '').includes('@') ? a.name : '')).trim().toLowerCase();
      const hostHeld = (a) => !!a.hostLogins?.[hostId] || (this._hostSubsKnown?.[hostId] || []).includes(a.id);
      // SERVER verdicts (B-f531): warm the probe now; the row rebuilds when
      // the answer lands (_warmHostAccountCache calls _updateAcctRow). While
      // present, verdicts override the legacy cache-derived linked/held.
      if (onHost && hostId) this._warmHostAccountCache?.(hostId);
      const vOf = (a) => (onHost ? this._hostVerdicts?.[hostId]?.[a.id] : null) || null;
      // Without verdicts every "not logged in on {host}" below is a confident
      // claim derived from NO data — it read as definitive for the ~15s probe
      // window (and for 2 min after a failed probe, pre-fix), so users picked
      // a worse account off it. Say which state we're actually in.
      // (gated on the warm state as well — a pre-verdict server answers fine
      // but sends no `verdicts`, and a bare absence test would pin it on
      // "checking…" forever)
      const acctWarm = onHost ? this._hostAcctWarmState?.[hostId] : null;
      const verdictsCold = onHost && !this._hostVerdicts?.[hostId] && (acctWarm === 'pending' || acctWarm === 'error');
      const unknownLabel = acctWarm === 'error'
        ? t('availability on {host} unknown — machine unreachable', { host: hostName })
        : t('checking {host}…', { host: hostName });
      const uncertainIds = new Set(); // disabled only because the probe hasn't answered
      for (const a of list) {
        // Pooled pseudo-account: neither an API key (the old else-branch
        // labeled it "— API key …undefined") nor a plain subscription.
        // Local-only by design (directory-symlink mechanics).
        if (a.pooled || a.type === 'pooled') {
          if (onHost) opts.push([a.id, a.name + ' — ' + t('pool (this machine only)'), true]);
          else opts.push([a.id, a.name + (a.currentName ? ` → ${a.currentName}` : ' · ' + t('pool'))]);
          continue;
        }
        if (a.type === 'subscription') {
          if (be === 'codex' || !onHost) {
            if (a.loggedIn && (!onHost || allowSubRemote)) opts.push([a.id, t('{name} (subscription)', { name: a.name })]);
            // Long-lived token (B-211a): usable locally via the env token even
            // with no local login (expired = disabled with the reason)
            else if (be !== 'codex' && a.oat) opts.push(a.oatDaysLeft <= 0
              ? [a.id, a.name + ' — ' + t('long-lived token expired'), true]
              : [a.id, a.name + ' ' + t('· long-lived token')]);
            continue;
          }
          const v = vOf(a);
          const linked = v ? (v.usable && v.how === 'host-login') : (!!hostOwnEmail && emailOf(a) === hostOwnEmail);
          const held = v ? (v.usable && v.how === 'host-held') : (!linked && hostHeld(a));
          if (linked) opts.push([a.id, a.name + ' ' + t('· is {host}’s machine login (same account)', { host: hostName })]);
          else if (held) opts.push([a.id, a.name + ' ' + t('· own login held on {host}', { host: hostName })]);
          else if ((v ? (v.usable && v.how === 'oat') : !!a.oat) && !(a.oatDaysLeft <= 0)) opts.push([a.id, a.name + ' ' + t('· via long-lived token')]);
          else if (a.oat && a.oatDaysLeft <= 0) opts.push([a.id, a.name + ' — ' + t('long-lived token expired'), true]);
          else if (v && v.reason === 'held-identity-mismatch') opts.push([a.id, a.name + ' — ' + t('host login belongs to {email}', { email: v.dirEmail || '?' }), true]);
          // !a.localOnly: macOS Keychain-backed logins never ship (PR #23) —
          // the verdict path already blocks via reason 'local-only-mac'
          else if (a.loggedIn && allowSubRemote && !a.localOnly && hostRec?.transport !== 'dial') opts.push([a.id, t('{name} (subscription)', { name: a.name })]);
          // Not usable there — show WHY instead of silently omitting (the
          // omission is what taught users the create-then-switch workaround).
          // Uncertain ⇒ say uncertain, never "not logged in".
          else {
            if (verdictsCold) uncertainIds.add(a.id);
            opts.push([a.id, a.name + ' — ' + (verdictsCold ? unknownLabel : t('not logged in on {host}', { host: hostName })), true]);
          }
        } else opts.push([a.id, t('{name} — API key …{tail}', { name: a.name, tail: a.tail })]);
      }
      for (const [v, label, disabled] of opts) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        if (disabled) o.disabled = true;
        acctSel.appendChild(o);
      }
      const keep = [...acctSel.options].find(o => o.value === prev && !o.disabled);
      // An UNCONFIRMED disable must not silently drop the user's pick: the row
      // is rebuilt when late verdicts land, so resetting here would leave the
      // dialog on Default while the (now enabled) account looks unselected —
      // i.e. the session gets created on a different account than the user
      // chose, silently. Hold the pick until the machine actually answers.
      const prevOpt = prev ? [...acctSel.options].find(o => o.value === prev) : null;
      if (keep || (prev && uncertainIds.has(prev))) acctSel.value = prev;
      else {
        acctSel.value = '';
        // Reset for a CONFIRMED reason — say it (only when the option is still
        // listed but disabled; a backend switch drops it entirely and needs no
        // alarm).
        if (prevOpt?.disabled) {
          const lost = all.find(a => a.id === prev);
          showToast(t('“{name}” isn’t available for this session — the account reset to Default', { name: lost?.name || prev }), { type: 'error' });
        }
      }
    };
    this._updateAcctRow = updateAcctRow; // freshest closure wins
    updateAcctRow();
    if (!this._acctListenersWired) {
      // Wire ONCE (this method runs on every dialog open) — call through the
      // stored freshest updater.
      this._acctListenersWired = true;
      document.getElementById('input-backend')?.addEventListener('change', () => this._updateAcctRow?.());
      document.getElementById('input-host')?.addEventListener('change', () => this._updateAcctRow?.());
    }
    // Host dropdown (remote sessions run over ssh + remote dtach; terminal only until P3)
    const hostSel = document.getElementById('input-host');
    if (hostSel) {
      fetchJson('/api/hosts').then(d => {
        this._nsHosts = d?.hosts || []; // account row reads name/transport from here
        hostSel.innerHTML = `<option value="">${t('Local')}</option>`;
        for (const h of d?.hosts || []) {
          const o = document.createElement('option');
          // dial devices have no user@host — show them as a device
          o.value = h.id; o.textContent = h.transport === 'dial' ? `${h.name} (${t('device')})` : `${h.name} (${h.user}@${h.host})`;
          hostSel.appendChild(o);
        }
        hostSel.value = hostId || '';
        // both terminal and chat supported on remote hosts (chat = ssh -T pipe)
        // switching host re-sources the path list + autocomplete target
        hostSel.onchange = () => this._fillCwdRecent(hostSel.value);
        this._fillCwdRecent(hostSel.value);
      });
    }
    const b = backend || 'claude';
    document.getElementById('input-backend').value = b;
    this._applySessionBackendOptions(b, { applyDefaults: true });
    document.getElementById('input-mode').value = this.settings.get('session.defaultMode') ?? 'chat';
    if (cwd) document.getElementById('input-cwd').value = cwd;
    this._fillCwdRecent(hostId || '');
    document.getElementById('input-cwd').focus();
  }
  hideDialogs() { document.getElementById('dialog-overlay').classList.add('hidden'); document.getElementById('dialog-overlay').querySelectorAll('.dialog').forEach(d => d.classList.add('hidden')); }

  _buildTitleMeta(source = {}) {
    const identity = pickAgentIdentity(source);
    return {
      backend: identity.backend,
      agentKind: identity.agentKind,
      agentRole: identity.agentRole,
      agentNickname: identity.agentNickname,
      sourceKind: identity.sourceKind,
      parentThreadId: identity.parentThreadId,
    };
  }

  // Plain shell terminal — no AI backend, same dtach persistence + window
  // New Session guard: stat the typed cwd (host-aware, '~' ok) and offer to
  // create it when missing. Returns true when the path is a usable directory
  // (possibly just created). Any stat failure is treated as "missing" — if the
  // real problem is elsewhere (permissions, unreachable host), the mkdir
  // attempt surfaces the actual error instead of us guessing.
  async _ensureCwdExists(cwd, hostId) {
    const hostQ = hostId ? `&host=${encodeURIComponent(hostId)}` : '';
    const info = await fetchJson(`/api/file/info?path=${encodeURIComponent(cwd)}${hostQ}`);
    if (info && !info.error) {
      if (info.isDirectory === false) {
        showToast(t('“{path}” is a file — a session needs a folder', { path: cwd }), { type: 'error' });
        return false;
      }
      return true;
    }
    const ok = await showConfirmDialog({
      title: t('Folder does not exist'),
      message: hostId
        ? t('“{path}” does not exist on the selected remote host. Create it and start the session there?', { path: cwd })
        : t('“{path}” does not exist. Create it and start the session there?', { path: cwd }),
      confirmText: t('Create folder'),
    });
    if (!ok) return false;
    const r = await fetchJson('/api/mkdir', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: cwd, host: hostId || undefined }),
    });
    if (!r || r.error) {
      showToast(t('Could not create “{path}”: {err}', { path: cwd, err: (r && r.error) || t('server unreachable') }), { type: 'error' });
      return false;
    }
    return true;
  }

  openFileExplorer(startPath, { syncId, host } = {}) {
    this._hideWelcome();
    const openSpec = { action: 'openFileExplorer', path: startPath, host: host || undefined };
    const winInfo = this.wm.createWindow({ title: t('File Explorer'), type: 'files', syncId, openSpec });
    if (host) winInfo._explorerHost = host; // read by FileExplorer constructor
    const explorer = new FileExplorer(winInfo, this, startPath);
    winInfo._explorer = explorer;
    winInfo.onClose = () => { explorer.dispose(); this._checkWelcome(); };
    return winInfo;
  }

  /** Stale-bundle guard (2.160.1, real fleet incident): a tab left open
   *  across a server update keeps its OLD bundle and silently misbehaves
   *  against the new server — every window blank, creates lost without a
   *  trace, while the sidebar's HTTP polls keep working ("all sessions
   *  died"). The tab that RUNS the update reloads itself; every other tab
   *  never did. On each ws (re)connect, compare the bundle's baked version
   *  with the server's; mismatch → reload ONCE per server version (the
   *  guard keeps dev instances that rebuild without a version bump from
   *  reload-looping). */
  async _checkBundleFreshness() {
    try {
      if (!BUILD_VERSION) return;
      const r = await fetchJson('/api/version');
      const srv = r?.version;
      if (!srv || srv === BUILD_VERSION) return;
      const key = 'vibespace.reloaded-for.' + srv;
      // PER-TAB, not per-origin (2.240.3, userN's "updated but still broken"
      // marathon): localStorage is shared across every tab of the origin, so
      // the FIRST tab to reload burned the once-per-version key and every
      // OTHER stale tab never auto-reloaded — it kept its old bundle and
      // silently misbehaved against the new server, looking exactly like
      // "the fix didn't work". sessionStorage is per-tab and survives the
      // reload within it, preserving the anti-loop property where it matters.
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, String(Date.now()));
      try { track('event', 'stale-bundle-reload', BUILD_VERSION + ' -> ' + srv); } catch { }
      showToast(t('VibeSpace was updated — reloading this tab…'));
      setTimeout(() => location.reload(), 800);
    } catch { }
  }

  _probeVncAvailability(attempt = 0) {
    fetchJson('/api/vnc/status').then((d) => {
      // fetchJson resolves null/undefined on HTTP errors — treat as a failed
      // probe (retry), not as "server says unavailable".
      if (d == null) throw new Error('probe failed');
      this._vncAvailable = !!d.available;
      const b = document.getElementById('btn-desktop');
      if (b) b.style.display = (this._vncAvailable && this.settings.get('toolbar.showDesktopButton') !== false) ? '' : 'none';
    }).catch(() => {
      // Page loaded during a server-restart window: retry with backoff so the
      // Desktop entry self-heals without needing an F5 or a ws transition
      // (userW hit the vanish repeatedly during an update storm).
      if (attempt < 5) setTimeout(() => this._probeVncAvailability(attempt + 1), [3000, 8000, 20000, 45000, 90000][attempt]);
    });
  }

  openBrowser(url, opts) { return openBrowserFn(this, url, opts); }
  openDesktop(opts) { return openDesktopFn(this, opts); }

  openTaskDetail(taskId, opts) { return openTaskDetailFn(this, taskId, opts); }
  openTaskLog(taskId, opts) { return openTaskLogFn(this, taskId, opts); }
  openUsage(opts) { return openUsageWindow(this, opts || {}); }
  openJobs(opts) { return openJobsWindow(this, opts || {}); }
  openJobInteract(jobId, opts) { return openInteractWindow(this, jobId, opts || {}); }

  // Diagnostics report: renders the local telemetry summary (client errors,
  // boot crashes, feature usage) as a static HTML page in the embedded
  // browser — same blob-URL pattern as the chat html Preview button.
  

  openSessionProps(sessionRef, opts) { return openSessionPropsFn(this, sessionRef, opts); }

  // Anthropic accounts (billing identity). Full snapshot incl. subscription
  // login state + importable CLI key; the accounts-updated broadcast keeps the
  // list fresh between refreshes.
  refreshAccounts() {
    return fetchJson('/api/accounts').then(d => {
      if (d) this._accounts = { accounts: d.accounts || [], defaultAccountId: d.defaultAccountId || null, defaultCodexAccountId: d.defaultCodexAccountId || null, subscription: d.subscription || {}, cliKey: d.cliKey || {} };
      if (d?.hostNames) this._hostNamesKnown = d.hostNames; // id→name for chips (2.244.1)
      return this._accounts;
    }).catch(() => this._accounts);
  }

  openWorkflowDetail(runId, opts) { return openWorkflowDetailFn(this, runId, opts); }

  // Session state keys (backend:backendSessionId) of every window currently
  // blinking "waiting for input" — the idle-detection signal the task board
  // aggregates into per-task attention (design §7: observe, never act).
  getWaitingSessionKeys() {
    const keys = new Set();
    for (const winInfo of this.wm.windows.values()) {
      if (!winInfo.element?.classList?.contains('window-waiting')) continue;
      const spec = winInfo._openSpec;
      let backend = spec?.backend || 'claude';
      let bsid = spec?.backendSessionId || null;
      if (!bsid && spec?.serverId) {
        const live = (this.sidebar?._webuiSessions || []).find(s => s.id === spec.serverId);
        if (live) { backend = live.backend || backend; bsid = live.backendSessionId || live.claudeSessionId || null; }
      }
      if (bsid) keys.add(`${backend}:${bsid}`);
    }
    return keys;
  }

  // Host id → display name, resolved for remote-file window titles etc. Lazily
  // loaded from /api/hosts and cached (the sidebar's _hostNames is only present
  // once the Remote tab has rendered, so titles showed the raw host id).
  hostName(id) { return (this._hostNames && this._hostNames[id]) || id; }
  async _ensureHostNames() {
    if (this._hostNames) return this._hostNames;
    this._hostNames = {};
    try { const d = await fetchJson('/api/hosts'); for (const h of d?.hosts || []) this._hostNames[h.id] = h.name; } catch {}
    // keep it fresh when hosts change
    if (!this._hostNamesWired) { this._hostNamesWired = true; this.ws.onGlobal((m) => { if (m.type === 'hosts-updated' || m.type === 'user-state-updated') this._hostNames = null; }); }
    return this._hostNames;
  }

  openFile(filePath, fileName, opts) {
    FileViewer.open(this, filePath, fileName, opts);
  }

  openEditor(filePath, fileName, opts = {}) {
    this._hideWelcome();
    // Front-truncate the path (like the file explorer) so the taskbar/title-bar
    // CSS end-ellipsis keeps the filename visible instead of cutting it off.
    // Remote files carry a "<host>: " prefix (like the explorer) so it's clear
    // the file is NOT local. Name may not be cached yet — set it now with the
    // best value, then re-title once _ensureHostNames resolves.
    const hostPfx = (h) => opts.host ? (h(opts.host) || opts.host) + ': ' : '';
    const title = opts._tempFile ? t('View: {name}', { name: fileName }) : hostPfx((id) => this.hostName(id)) + frontTruncate(filePath);
    const openSpec = opts._tempFile ? undefined : { action: 'openEditor', path: filePath, name: fileName, ...(opts.host ? { host: opts.host } : {}) };
    const winInfo = this.wm.createWindow({ title, type: 'editor', syncId: opts.syncId, openSpec });
    if (opts.host && !opts._tempFile) this._ensureHostNames().then(() => { try { this.wm.setTitle(winInfo.id, this.hostName(opts.host) + ': ' + frontTruncate(filePath)); } catch {} });
    winInfo._filePath = filePath; winInfo._fileName = fileName;
    new CodeEditor(winInfo, filePath, fileName, this, opts);
    winInfo.onClose = () => {
      if (opts._onCloseDelete) opts._onCloseDelete();
      this._checkWelcome();
    };
    return winInfo;
  }

  // Delegate to extracted external-editor.js module
  _openExternalEditor(filePath, signalPath, sessionId, host) { openExternalEditor(this, filePath, signalPath, sessionId, host); }
  _closeExternalEditor(signalPath) { closeExternalEditor(this, signalPath); }

  _hideWelcome() { document.getElementById('welcome').classList.add('hidden'); }
  _checkWelcome() {
    const activeDesk = this.desktopManager?.activeDesktopId;
    let hasWindows = false;
    if (activeDesk) {
      for (const [, win] of this.wm.windows) {
        if (win._desktopId === activeDesk && !win._hiddenByDesktop) { hasWindows = true; break; }
      }
    } else {
      hasWindows = this.wm.windows.size > 0;
    }
    if (!hasWindows) document.getElementById('welcome').classList.remove('hidden');
    else document.getElementById('welcome').classList.add('hidden');
  }

  // Switch to the window's desktop and flash it
  // Start Move mode on a session's window from the sidebar — the recovery
  // path when a window was dragged off-screen and can't be grabbed anymore.
  // Resolves tab groups to the host and switches to the window's desktop first.
  moveSessionWindow(serverSessionId) {
    for (const [winId, term] of this.sessions) {
      if (term.sessionId !== serverSessionId) continue;
      const win = this.wm.windows.get(winId);
      if (!win) break;
      let targetId = winId, targetWin = win;
      if (win._tabChain && win._tabChain.tabs[0] !== winId) {
        const hostId = win._tabChain.tabs[0];
        const host = this.wm.windows.get(hostId);
        if (host) {
          targetId = hostId; targetWin = host;
          const tabIdx = win._tabChain.tabs.indexOf(winId);
          if (tabIdx >= 0) this.wm.switchTab(win._tabChain, tabIdx);
        }
      }
      const dm = this.desktopManager;
      const start = () => this.wm.startMoveMode(targetId);
      if (dm && targetWin._desktopId && targetWin._desktopId !== dm.activeDesktopId) {
        dm.switchTo(targetWin._desktopId).then(start);
      } else {
        start();
      }
      break;
    }
  }

  goToWindow(serverSessionId) {
    for (const [winId, term] of this.sessions) {
      if (term.sessionId === serverSessionId) {
        this.goToWinId(winId);
        break;
      }
    }
  }

  // Window-id based go-to (2.212.0): the title-bar/taskbar "Switch window"
  // submenu targets ANY window type, not just sessions. Same semantics as
  // goToWindow: tab-chain resolve, stage-aware, cross-desktop switch, flash.
  goToWinId(winId) {
    const win = this.wm.windows.get(winId);
    if (!win) return;

    // Resolve tab group: find host and switch to target tab
    let targetWin = win, targetId = winId;
    if (win._tabChain && win._tabChain.tabs[0] !== winId) {
      const hostId = win._tabChain.tabs[0];
      const host = this.wm.windows.get(hostId);
      if (host) {
        targetWin = host; targetId = hostId;
        const tabIdx = win._tabChain.tabs.indexOf(winId);
        if (tabIdx >= 0) this.wm.switchTab(win._tabChain, tabIdx);
      }
    }

    const dm = this.desktopManager;
    const doFlash = () => {
      if (targetWin.isMinimized) this.wm.restore(targetId);
      this.wm.focusWindow(targetId);
      targetWin.element.classList.add('window-find-flash');
      setTimeout(() => targetWin.element.classList.remove('window-find-flash'), 3000);
    };
    if (this.stage?.isActive) {
      // On the stage, "go to" means MATERIALIZE as the hero — focusWindow
      // is the stage's interception point. Switching desktops out from
      // under the stage desynced the view (real report: desktop switched
      // while the preview stayed on the stage).
      doFlash();
    } else if (dm && targetWin._desktopId && targetWin._desktopId !== dm.activeDesktopId) {
      dm.switchTo(targetWin._desktopId).then(doFlash);
    } else {
      doFlash();
    }
    const session = this.sessions.get(winId);
    if (session) session.focus?.();
  }

  // Flash a window's title bar + taskbar item to help user find it
  flashWindow(serverSessionId) {
    for (const [winId, term] of this.sessions) {
      if (term.sessionId === serverSessionId) {
        const win = this.wm.windows.get(winId);
        if (!win) break;

        const dm = this.desktopManager;

        // Resolve the visible window: if in a tab group, find the host and switch to this tab
        let flashWin = win;
        let flashWinId = winId;
        if (win._tabChain && win._tabChain.tabs[0] !== winId) {
          const hostId = win._tabChain.tabs[0];
          const host = this.wm.windows.get(hostId);
          if (host) {
            flashWin = host;
            flashWinId = hostId;
            // Switch to the target tab
            const tabIdx = win._tabChain.tabs.indexOf(winId);
            if (tabIdx >= 0) this.wm.switchTab(win._tabChain, tabIdx);
          }
        }

        // If window is on another desktop, flash its rect in the desktop preview
        if (dm && flashWin._desktopId && flashWin._desktopId !== dm.activeDesktopId) {
          dm._flashingWinId = flashWinId;
          dm._renderSwitcher();
          setTimeout(() => { dm._flashingWinId = null; dm._renderSwitcher(); }, 3000);
          break;
        }

        flashWin.element.classList.add('window-find-flash');
        // Match by winId — index-based mapping diverged from taskbar order as
        // soon as tab groups or a second desktop existed (taskbar skips those)
        const taskbarItem = document.querySelector(`.taskbar-item[data-win-id="${CSS.escape(flashWinId)}"]`);
        if (taskbarItem) taskbarItem.classList.add('find-flash');
        // Also flash in desktop preview
        if (dm) {
          dm._flashingWinId = flashWinId;
          dm._renderSwitcher();
        }
        if (flashWin.isMinimized) this.wm.restore(flashWinId);
        this.wm.focusWindow(flashWinId);
        setTimeout(() => {
          flashWin.element.classList.remove('window-find-flash');
          if (taskbarItem) taskbarItem.classList.remove('find-flash');
          if (dm) { dm._flashingWinId = null; dm._renderSwitcher(); }
        }, 3000);
        break;
      }
    }
  }

  renameBackendSession(sessionRef, newName) {
    if (!sessionRef || typeof sessionRef !== 'object') return;
    this.ws.send({
      type: 'rename-session',
      webuiId: sessionRef.webuiId || undefined,
      sessionKey: getSessionKey(sessionRef) || undefined,
      backendSessionId: sessionRef.backendSessionId || sessionRef.sessionId || undefined,
      name: newName || '',
    });
  }

  syncSessionName(sessionRef, newName) {
    const targetKey = (sessionRef && typeof sessionRef === 'object')
      ? getSessionKey(sessionRef)
      : (typeof sessionRef === 'string' && sessionRef.includes(':') ? sessionRef : '');
    for (const [winId, term] of this.sessions) {
      if (!term.sessionId) continue;
      const allSess = this.sidebar?._allSessions || [];
      const match = allSess.find((s) => {
        if (s.webuiId !== term.sessionId) return false;
        if (targetKey) return getSessionKey(s) === targetKey;
        if (typeof sessionRef === 'string') return s.sessionId === sessionRef || s.backendSessionId === sessionRef;
        return false;
      });
      if (match) {
        const cwd = match.cwd || '';
        this.wm.setTitle(winId, `${newName} — ${cwd}`);
        break;
      }
    }
  }

  syncSessionIdentity(allSessions = []) {
    // Runs on every 5s merge — index once instead of find() per window over
    // the full ~5k-entry list (which also allocated two template strings per
    // probed entry; audit round-2 confirmed hot path).
    const byWebui = new Map();
    const byKey = new Map();
    for (const entry of allSessions) {
      if (entry.webuiId && !byWebui.has(entry.webuiId)) byWebui.set(entry.webuiId, entry);
      const k = entry.sessionKey || `${entry.backend || 'claude'}:${entry.backendSessionId || entry.sessionId}`;
      if (!byKey.has(k)) byKey.set(k, entry);
    }
    for (const [winId, session] of this.sessions) {
      const win = this.wm.windows.get(winId);
      if (!win) continue;
      const spec = win._openSpec || {};
      let match = byWebui.get(session.sessionId) || null;
      if (!match && (spec.sessionKey || spec.backendSessionId || spec.sessionId)) {
        const specKey = spec.sessionKey || `${spec.backend || win.titleMeta?.backend || 'claude'}:${spec.backendSessionId || spec.sessionId || ''}`;
        match = byKey.get(specKey) || null;
      }
      if (!match) continue;
      // Persist a fork's chosen title as a custom name once its NEW backend id
      // is adopted (after the first turn) — before that, match.backendSessionId
      // is still the parent's, and renaming then would clobber the parent.
      const pendingFork = this._pendingForkTitles?.get(session.sessionId);
      if (pendingFork && match.backendSessionId && match.backendSessionId !== pendingFork.parentId) {
        this.sidebar.setCustomName?.(match.sessionKey || getSessionKey(match), pendingFork.name);
        this._pendingForkTitles.delete(session.sessionId);
      }
      // A user-typed New Session name becomes the custom name once the backend
      // id exists (before that there is no stable key to attach it to). A
      // manual rename in the meantime wins — don't clobber it.
      const pendingName = this._pendingCreateNames?.get(session.sessionId);
      if (pendingName && match.backendSessionId) {
        if (!this.sidebar.getCustomName?.(match)) {
          this.sidebar.setCustomName?.(match.sessionKey || getSessionKey(match), pendingName);
        }
        this._pendingCreateNames.delete(session.sessionId);
      }
      this.wm.setTitleMeta(winId, this._buildTitleMeta(match));
      this.wm.setAuthBadge?.(winId, match.auth || null); // billing key in the title bar
      // Mobile has no window title bars → no badge; the chat status bar hosts
      // the identity chip there instead (same click-to-switch).
      if (this.isMobile) session.setBillingIdentity?.(match.auth || null, (el) => this.showBillingSwitcher(winId, el));
      if (win._openSpec) {
        // NEVER write the webui server id into backendSessionId: a session
        // whose CLI hasn't reported its real id yet (remote spawns stay in
        // that state for a long time) used to get `sess-N-…` baked into the
        // spec — other clients then re-resolved against that bogus id, missed,
        // and opened a BLANK view-only window (real report, remote hosts).
        const realBsid = match.backendSessionId
          || (match.sessionId && match.sessionId !== match.webuiId ? match.sessionId : null);
        Object.assign(win._openSpec, {
          backend: match.backend || win._openSpec.backend || 'claude',
          backendSessionId: realBsid || win._openSpec.backendSessionId || null,
          sessionKey: realBsid ? (match.sessionKey || getSessionKey(match)) : (win._openSpec.sessionKey || ''),
          // Live session entries carry the host under `host` (not `hostId`) —
          // reading only match.hostId meant a remote session's spec NEVER got
          // its host backfilled, so after the session died the replay/view
          // fetch went host-less and opened blank (real fleet report: 5
          // pre-hostId-era windows on userL's layout, dead after an OOM).
          hostId: match.host ?? match.hostId ?? win._openSpec.hostId ?? null,
          name: match.name || win._openSpec.name || '',
          agentKind: match.agentKind || 'primary',
          agentRole: match.agentRole || '',
          agentNickname: match.agentNickname || '',
          sourceKind: match.sourceKind || '',
          parentThreadId: match.parentThreadId || null,
        });
      }
      if (win._openSpec?.action === 'viewSession' || win._openSpec?.action === 'attachSession') {
        const displayName = this.sidebar.getCustomName?.(match) || match.webuiName || match.name || win._openSpec?.name || win.title || t('Session');
        const cwd = match.cwd || win._openSpec?.cwd || '';
        this.wm.setTitle(winId, cwd ? `${displayName} — ${cwd}` : displayName);
      }
    }
      try { this.stage?.onIdentitySync?.(); } catch { }
  }

  _notifySidebarFocus() {
    // Find the claude session ID for the currently focused terminal window
    const activeWinId = this.wm.activeWindowId;
    const term = this.sessions.get(activeWinId);
    if (term && term.sessionId) {
      const allSess = this.sidebar?._allSessions || [];
      let match = allSess.find(s => s.webuiId === term.sessionId);
      if (!match) {
        // Terminated/read-only windows: the live entry is gone — match the
        // STOPPED sidebar entry via the identity in the openSpec (also covers
        // view-history windows, whose sessionId never matches a webuiId).
        const spec = this.wm.windows.get(activeWinId)?._openSpec;
        const bsid = spec?.backendSessionId;
        if (bsid) {
          const be = spec.backend || 'claude';
          match = allSess.find(s => (s.backendSessionId || s.sessionId) === bsid && (s.backend || 'claude') === be);
        }
      }
      if (match) {
        this.sidebar.highlightSession(match.sessionId);
        return;
      }
    }
    // No terminal focused — clear highlight
    this.sidebar.highlightSession(null);
  }

  updateTaskbar() {
    updateTaskbarFn(this);
    if (this.desktopManager) this.desktopManager._renderSwitcher();
    // Waiting-blink propagation to tab headers rides the same funnel (every
    // waiting toggle calls winInfo._notifyChanged → here) — a grouped guest's
    // own titlebar is hidden, so its TAB must carry the blink instead.
    this.wm.refreshTabWaiting?.();
    // Task attention rides the same signal: every waiting-blink toggle and
    // window open/close funnels through here (winInfo._notifyChanged), so the
    // board's ⚠ badges stay live without their own event plumbing. Debounced —
    // updateTaskbar fires in bursts during layout changes.
    clearTimeout(this._taskAttnTimer);
    this._taskAttnTimer = setTimeout(() => this.sidebar?.refreshTaskAttention?.(), 250);
  }

  _populateThemeSelect(sel) {
    sel.innerHTML = '';
    const opt = (v, l) => { const o = document.createElement('option'); o.value = v; o.textContent = l; return o; };
    for (const name of BUILTIN_THEMES) sel.appendChild(opt(name, name.charAt(0).toUpperCase() + name.slice(1)));
    const customKeys = this.themeManager.getThemeNames().filter(n => n.startsWith('custom-'));
    if (customKeys.length) {
      const sep = document.createElement('option'); sep.disabled = true; sep.textContent = '── Custom ──'; sel.appendChild(sep);
      for (const key of customKeys) sel.appendChild(opt(key, key.slice(7)));
    }
    // plugin-contributed themes (Plugin Ph4) — labelled "<label> (plugin)" by the plugin client
    const pluginThemes = this.themeManager.getPluginThemes?.() || [];
    if (pluginThemes.length) {
      const sep = document.createElement('option'); sep.disabled = true; sep.textContent = '── Plugins ──'; sel.appendChild(sep);
      for (const th of pluginThemes) sel.appendChild(opt(th.key, th.label));
    }
  }

  _refreshThemeDropdown() {
    const sel = document.getElementById('global-theme-select');
    if (sel) { this._populateThemeSelect(sel); sel.value = this.themeManager.current; }
  }

  async _loadCustomThemes() {
    const themes = await fetchJson('/api/custom-themes');
    if (!themes) return;
    this._applyCustomThemesFromServer(themes);
    this.themeManager.applyPendingTheme();
  }

  _applyCustomThemesFromServer(themes) {
    // Unregister deleted themes
    for (const key of this.themeManager.getThemeNames().filter(n => n.startsWith('custom-'))) {
      const name = key.slice(7);
      if (!themes[name]) this.themeManager.unregisterCustomTheme(name);
    }
    // Register/update
    for (const [name, data] of Object.entries(themes)) {
      this.themeManager.registerCustomTheme(name, data.css, data.terminal);
    }
    this._refreshThemeDropdown();
    // Update terminal themes
    for (const [, session] of this.sessions) {
      if (session.updateTheme) session.updateTheme(this.themeManager.getTerminalTheme());
    }
  }
}

export { App };

// Prototype mixins split out of this file (2.82.0 audit) — installed at import time, before any instantiation.
installManageAgents(App);
installPluginsUI(App);

installUsageMeter(App);
installSessionLifecycle(App);
installSetupFlows(App);

// ── WINDOW-TYPE REGISTRATIONS (Plugin Ph1): the kinds App itself opens ──
registerWindowType({
  type: 'files', label: 'File Explorer',
  icon: svgIcon16('<path d="M2 3h4l2 2h6v8H2V3z"/>'),
  action: 'openFileExplorer', replay: (app, spec, { syncId } = {}) => app.openFileExplorer(spec.path, { syncId, host: spec.host }),
});
registerWindowType({
  type: 'editor', label: 'Editor',
  icon: svgIcon16('<path d="M11.5 1.5l3 3L5 14H2v-3z"/>'),
  action: 'openEditor', replay: (app, spec, { syncId } = {}) => app.openEditor(spec.path, spec.name, { syncId, host: spec.host }),
});
