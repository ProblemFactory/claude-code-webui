import { ThemeManager, THEMES, BUILTIN_THEMES } from './themes.js';
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
import { createPopover, fetchJson, initStateSync } from './utils.js';
import { setupDirAutocomplete } from './autocomplete.js';
import { getAvailableFonts } from './terminal.js';
import { SettingsManager } from './settings.js';
import { SETTINGS_SCHEMA } from './settings-schema.js';
import { SettingsUI } from './settings-ui.js';
import { openExternalEditor, closeExternalEditor } from './external-editor.js';
import { CommandMode } from './command-mode.js';
import { updateTaskbar as updateTaskbarFn, showWindowList } from './taskbar.js';
import { openBrowser as openBrowserFn } from './browser-window.js';
import { DesktopManager } from './desktop-manager.js';
import { createBackendIconHtml, getSessionKey, pickAgentIdentity } from './agent-meta.js';

const BACKEND_SESSION_OPTIONS = {
  claude: {
    models: [{ id: '', label: 'Default' }, { id: 'opus', label: 'opus (latest, 200k)' }, { id: 'opus[1m]', label: 'opus[1m] (latest, 1M)' }, { id: 'sonnet', label: 'sonnet (latest)' }, { id: 'sonnet[1m]', label: 'sonnet[1m] (latest, 1M)' }, { id: 'haiku', label: 'haiku (latest)' }],
    permissions: [
      { value: '', label: 'Default' },
      { value: 'auto', label: 'Auto' },
      { value: 'bypassPermissions', label: 'Bypass' },
      { value: 'plan', label: 'Plan' },
      { value: 'acceptEdits', label: 'Accept Edits' },
    ],
    efforts: [
      { value: '', label: 'Auto (model default)' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max (Opus 4.6 only)' },
    ],
  },
  codex: {
    models: [{ id: '', label: 'Default' }],
    permissions: [
      { value: '', label: 'Default' },
      { value: 'read-only', label: 'Read Only' },
      { value: 'safe-yolo', label: 'Safe Yolo' },
      { value: 'yolo', label: 'Yolo' },
    ],
    efforts: [
      { value: '', label: 'Auto (model default)' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'XHigh' },
    ],
  },
};

// Fetch available models from server (Claude from /v1/models API, Codex from cache)
fetchJson('/api/available-models').then(data => {
  if (!data) return;
  const toSchemaOptions = (models) => models.map(m => ({ value: m.id, label: m.label || m.id || 'Default' }));
  if (data.claude?.length) {
    BACKEND_SESSION_OPTIONS.claude.models = data.claude;
    SETTINGS_SCHEMA['claude.defaultModel'].options = toSchemaOptions(data.claude);
  }
  if (data.codex?.length) {
    BACKEND_SESSION_OPTIONS.codex.models = data.codex;
    SETTINGS_SCHEMA['codex.defaultModel'].options = toSchemaOptions(data.codex);
  }
});

class App {
  constructor() {
    this.settings = new SettingsManager();
    this.themeManager = new ThemeManager();
    this.ws = new WsManager();
    this.wm = new WindowManager(document.getElementById('workspace'));
    this.wm._settings = this.settings;
    this.wm._app = this;
    // Re-render all tab bars when tab wrap setting changes
    this.settings.on('window.tabWrap', () => {
      for (const [, win] of this.wm.windows) {
        if (win._tabChain && win._tabChain.tabs[0] === win.id) this.wm._renderTabBar(win._tabChain);
      }
    });
    this.sessions = new Map();
    this.attachedServerSessions = new Set();
    this.layoutManager = new LayoutManager(this);
    this.desktopManager = new DesktopManager(this);

    // Tag every new window with the active desktop ID
    const origCreateWindow = this.wm.createWindow.bind(this.wm);
    this.wm.createWindow = (opts) => {
      const win = origCreateWindow(opts);
      if (this.desktopManager.activeDesktopId) {
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
    });

    // Load custom themes from server
    this._loadCustomThemes();

    this._setupToolbar();
    this._setupDialogs();
    this._setupWelcome();
    this._setupGlobalSettings();
    this._setupGridConfig();
    this._setupLayoutManager();
    this._setupUsage();
    this._commandMode = new CommandMode(this, this.settings);

    // Listen for editor open/close requests (from editor-helper.sh via server HTTP→WebSocket)
    this.ws.onGlobal((msg) => {
      if (msg.type === 'editor-open' && msg.filePath && msg.signalPath) {
        this._openExternalEditor(msg.filePath, msg.signalPath, msg.sessionId);
      } else if (msg.type === 'editor-close' && msg.signalPath) {
        this._closeExternalEditor(msg.signalPath);
      }
    });

    fetch('/api/home').then(r=>r.json()).then(d=> { document.getElementById('input-cwd').placeholder = d.home; }).catch(()=>{});

    // Initialize unified state sync (server-persisted, versioned diff broadcast, reconnect recovery)
    initStateSync(this.ws);

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
      for (const [winId, session] of this.sessions) {
        if (session instanceof TerminalSession && session.sessionId) {
          this.ws.send({ type: 'attach', sessionId: session.sessionId });
        }
      }
    });

    // Mobile nav bar
    this._setupMobileNav();
    // Mobile: swipe from left edge to open sidebar
    this._setupMobileGestures();
  }

  _setupMobileNav() {
    const nav = document.getElementById('mobile-nav');
    if (!nav) return;
    document.getElementById('mobile-nav-menu').onclick = () => this.sidebar.toggle(true);
    document.getElementById('mobile-nav-new').onclick = () => this.showNewSessionDialog();
    // Update title when active window changes
    this._mobileNavTitle = document.getElementById('mobile-nav-title');
  }

  _updateMobileNavTitle() {
    if (!this._mobileNavTitle) return;
    const win = this.wm.windows.get(this.wm.activeWindowId);
    this._mobileNavTitle.textContent = win?.title || 'Claude Code';
  }

  _setupMobileGestures() {
    let startX = 0, startY = 0;
    document.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > 80 && Math.abs(dy) < 50) {
        if (dx > 0 && startX < 30) this.sidebar.toggle(true); // swipe right from left edge
        else if (dx < 0 && this.sidebar.isOpen) this.sidebar.toggle(false); // swipe left to close
      }
    }, { passive: true });
  }

  _setupToolbar() {
    document.querySelectorAll('.layout-btn[data-layout]').forEach(btn => btn.addEventListener('click', () => this.wm.applyLayout(btn.dataset.layout)));
    document.getElementById('btn-new-session').addEventListener('click', () => this.showNewSessionDialog());
    document.getElementById('btn-file-explorer').addEventListener('click', () => this.openFileExplorer());
    document.getElementById('btn-browser').addEventListener('click', () => this.openBrowser());

    // Apply toolbar visibility settings
    const applyToolbarSettings = () => {
      const presets = document.getElementById('layout-presets');
      if (presets) presets.style.display = this.settings.get('toolbar.showLayoutPresets') ? '' : 'none';
    };
    applyToolbarSettings();
    this.settings.on('toolbar.showLayoutPresets', applyToolbarSettings);
  }

  _setupWelcome() {
    document.getElementById('welcome-new').addEventListener('click', () => this.showNewSessionDialog());
    document.getElementById('welcome-files').addEventListener('click', () => this.openFileExplorer());
  }

  _setupGlobalSettings() {
    this._fontSize = parseInt(localStorage.getItem('termFontSize')) || 14;
    this._fontFamily = localStorage.getItem('termFontFamily') || getAvailableFonts()[0]?.value || 'monospace';
    this._settingsUI = new SettingsUI(this);

    const btn = document.getElementById('btn-global-settings');
    btn.onclick = (e) => { e.stopPropagation(); this._showGlobalSettings(btn); };
  }

  _showGlobalSettings(anchor) {
    const pop = createPopover(anchor, 'global-settings-popover');
    const rect = anchor.getBoundingClientRect();
    pop.style.left = '';
    pop.style.top = (rect.bottom + 4) + 'px';
    pop.style.right = (window.innerWidth - rect.right) + 'px';

    const opt = (v, l) => { const o = document.createElement('option'); o.value = v; o.textContent = l; return o; };

    // Theme
    const themeLabel = document.createElement('label'); themeLabel.textContent = 'Theme';
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
    editBtn.title = 'Theme Editor';
    editBtn.onclick = (e) => { e.stopPropagation(); if (!this._themeEditor) this._themeEditor = new ThemeEditor(this); this._themeEditor.open(); };

    // Font size
    const sizeLabel = document.createElement('label'); sizeLabel.textContent = 'Font Size';
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
    const fontLabel = document.createElement('label'); fontLabel.textContent = 'Font';
    const fontSel = document.createElement('select');
    for (const f of getAvailableFonts()) {
      const o = opt(f.value === '_sep' ? '' : f.value, f.label);
      if (f.disabled) { o.disabled = true; o.style.fontSize = '9px'; o.style.color = 'var(--text-dim)'; }
      fontSel.appendChild(o);
    }
    fontSel.value = this._fontFamily;
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

    // "All Settings" link
    const allSettingsLink = document.createElement('div');
    allSettingsLink.className = 'settings-all-link';
    allSettingsLink.textContent = 'All Settings...';
    allSettingsLink.onclick = () => { pop.remove(); this._settingsUI.open(); };

    pop.append(themeLabel, themeSel, editBtn, sizeLabel, sizeRow, fontLabel, fontSel, allSettingsLink);
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
    btn.title = `${rows}×${cols} grid`;
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
    // Save to server
    const data = await fetchJson('/api/custom-grids', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows, cols }),
    });
    if (data) { this._customGrids = data.customGrids || []; this._renderCustomGridButtons(); }
  }

  async _removeCustomGrid(rows, cols) {
    const data = await fetchJson('/api/custom-grids', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows, cols }),
    });
    if (data) { this._customGrids = data.customGrids || []; this._renderCustomGridButtons(); }
  }

  _setupUsage() {
    this._usageData = new Map(); // sessionId → usage
    this._codexRateLimit = null;
    const usageEl = document.getElementById('taskbar-usage');
    const popup = document.getElementById('usage-popup');

    usageEl.onclick = () => popup.classList.toggle('hidden');
    document.addEventListener('mousedown', (e) => {
      if (!popup.contains(e.target) && !usageEl.contains(e.target)) popup.classList.add('hidden');
    });

    // Poll usage for active sessions
    this._pollUsage();
  }

  async _pollUsage() {
    const data = await fetchJson('/api/usage');
    if (data?.rateLimit) this._rateLimit = data.rateLimit;
    else if (this._rateLimit === undefined) this._rateLimit = null;
    if (data?.codexRateLimit) this._codexRateLimit = data.codexRateLimit;
    else if (this._codexRateLimit === undefined) this._codexRateLimit = null;
    this._renderUsage();
    setTimeout(() => this._pollUsage(), 30000);
  }

  _renderUsage() {
    const usageEl = document.getElementById('taskbar-usage');
    const popup = document.getElementById('usage-popup');
    const rl = this._rateLimit;
    const codex = this._codexRateLimit;

    if (!rl && !codex) {
      usageEl.innerHTML = '';
      popup.innerHTML = '<div class="empty-hint">No usage data</div>';
      return;
    }

    const usageColor = (pct) => (pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow)' : 'var(--green)');
    const renderPie = (label, pct) => {
      const clamped = Math.max(0, Math.min(100, Math.round(pct || 0)));
      const color = usageColor(clamped);
      const deg = Math.round(clamped * 3.6);
      return `<div class="usage-pie" title="${label}: ${clamped}%" style="background:conic-gradient(${color} ${deg}deg, var(--bg-input) ${deg}deg)"></div>`;
    };
    const renderRow = (backend, primaryLabel, primaryPct, secondaryLabel, secondaryPct) => (
      `<div class="taskbar-usage-row">
        ${createBackendIconHtml(backend, { className: 'taskbar-usage-backend', title: backend === 'codex' ? 'Codex' : 'Claude' })}
        <div class="taskbar-usage-pair">
          ${renderPie(primaryLabel, primaryPct)}
          ${renderPie(secondaryLabel, secondaryPct)}
        </div>
      </div>`
    );
    const renderSectionTitle = (backend, label) => (
      `<div class="usage-section-title">${createBackendIconHtml(backend, { className: 'usage-section-backend', title: label })}<span>${label}</span></div>`
    );

    const rows = [];
    const sections = [];
    let updatedAt = 0;
    const fmtReset = (ts) => {
      if (!ts) return '?';
      const d = new Date(ts * 1000), now = new Date();
      const time = d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
      if (d.toDateString() === now.toDateString()) return `Today ${time}`;
      const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
      if (d.toDateString() === tmr.toDateString()) return `Tomorrow ${time}`;
      return d.toLocaleDateString([], {month:'short',day:'numeric'}) + ' ' + time;
    };

    if (rl) {
      const pct5h = Math.round((rl.fiveHour?.utilization || 0) * 100);
      const color = usageColor(pct5h);
      const pct7d = Math.round((rl.sevenDay?.utilization || 0) * 100);
      const color7d = usageColor(pct7d);
      rows.push(renderRow('claude', '5h', pct5h, '7d', pct7d));
      updatedAt = Math.max(updatedAt, rl.fetchedAt || 0);
      sections.push(`${renderSectionTitle('claude', 'Claude')}
      <div class="usage-session">
        <div class="usage-session-name">5-hour limit</div>
        <div class="usage-bar" style="width:100%;margin:4px 0"><div class="usage-bar-fill" style="width:${pct5h}%;background:${color}"></div></div>
        <div class="usage-session-stats">
          <span class="usage-stat">${pct5h}% used</span>
          <span class="usage-stat"><span class="usage-stat-label">Resets</span> ${fmtReset(rl.fiveHour?.resetsAt)}</span>
        </div>
      </div>
      <div class="usage-session">
        <div class="usage-session-name">7-day limit</div>
        <div class="usage-bar" style="width:100%;margin:4px 0"><div class="usage-bar-fill" style="width:${pct7d}%;background:${color7d}"></div></div>
        <div class="usage-session-stats">
          <span class="usage-stat">${pct7d}% used</span>
          <span class="usage-stat"><span class="usage-stat-label">Resets</span> ${fmtReset(rl.sevenDay?.resetsAt)}</span>
        </div>
      </div>`);
    }

    if (codex?.fiveHour || codex?.sevenDay) {
      const pct5h = Math.round(codex.fiveHour?.usedPercent || ((codex.fiveHour?.utilization || 0) * 100));
      const pct7d = Math.round(codex.sevenDay?.usedPercent || ((codex.sevenDay?.utilization || 0) * 100));
      const color5h = usageColor(pct5h);
      const color7d = usageColor(pct7d);
      rows.push(renderRow('codex', '5h', pct5h, '7d', pct7d));
      updatedAt = Math.max(updatedAt, codex.fetchedAt || 0);
      sections.push(`${renderSectionTitle('codex', 'Codex')}
      <div class="usage-session">
        <div class="usage-session-name">5-hour limit</div>
        <div class="usage-bar" style="width:100%;margin:4px 0"><div class="usage-bar-fill" style="width:${pct5h}%;background:${color5h}"></div></div>
        <div class="usage-session-stats">
          <span class="usage-stat">${pct5h}% used</span>
          <span class="usage-stat"><span class="usage-stat-label">Resets</span> ${fmtReset(codex.fiveHour?.resetsAt)}</span>
        </div>
      </div>
      <div class="usage-session">
        <div class="usage-session-name">7-day limit</div>
        <div class="usage-bar" style="width:100%;margin:4px 0"><div class="usage-bar-fill" style="width:${pct7d}%;background:${color7d}"></div></div>
        <div class="usage-session-stats">
          <span class="usage-stat">${pct7d}% used</span>
          <span class="usage-stat"><span class="usage-stat-label">Resets</span> ${fmtReset(codex.sevenDay?.resetsAt)}</span>
          ${codex.planType ? `<span class="usage-stat"><span class="usage-stat-label">Plan</span> ${codex.planType}</span>` : ''}
        </div>
      </div>`);
    }

    const ago = updatedAt ? Math.round((Date.now() - updatedAt) / 60000) : 0;
    usageEl.innerHTML = rows.join('');
    popup.innerHTML = `${sections.join('')}<div class="usage-total" style="font-weight:400;color:var(--text-dim)">Updated ${ago < 1 ? 'just now' : ago + 'min ago'}</div>`;
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
      list.innerHTML = '<div class="empty-hint">No saved presets. Save current workspace as a preset.</div>';
      return;
    }
    for (const name of names) {
      const preset = presets[name];
      const card = document.createElement('div'); card.className = 'layout-card';
      const isCurrent = name === this.layoutManager._currentName;

      const info = document.createElement('div'); info.className = 'layout-card-info';
      info.innerHTML = `<div class="layout-card-name">${isCurrent ? '● ' : ''}${name}</div>
        <div class="layout-card-meta">${preset.windows?.length || 0} windows · ${preset.theme || 'dark'} · ${preset.updatedAt ? new Date(preset.updatedAt).toLocaleString() : ''}</div>`;
      info.onclick = () => {
        this.layoutManager.loadPreset(name).then(() => this.hideDialogs());
      };

      const actions = document.createElement('div'); actions.className = 'layout-card-actions';
      const btnOverwrite = document.createElement('button'); btnOverwrite.className = 'layout-card-btn'; btnOverwrite.textContent = '⟳';
      btnOverwrite.title = 'Overwrite with current';
      btnOverwrite.onclick = (e) => { e.stopPropagation(); this.layoutManager.savePreset(name).then(() => this._renderPresetsList()); };
      const btnDel = document.createElement('button'); btnDel.className = 'layout-card-btn delete'; btnDel.textContent = '✕';
      btnDel.title = 'Delete';
      btnDel.onclick = (e) => { e.stopPropagation(); this.layoutManager.deletePreset(name).then(() => this._renderPresetsList()); };
      actions.append(btnOverwrite, btnDel);

      card.append(info, actions);
      list.appendChild(card);
    }
  }

  _setupDialogs() {
    const overlay = document.getElementById('dialog-overlay');
    overlay.querySelectorAll('.dialog-close, .btn-cancel').forEach(btn => btn.addEventListener('click', () => this.hideDialogs()));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.hideDialogs(); });

    const backendInput = document.getElementById('input-backend');
    backendInput.addEventListener('change', () => this._applySessionBackendOptions(backendInput.value, { applyDefaults: true }));
    this._applySessionBackendOptions(backendInput.value || 'claude', { applyDefaults: true });

    document.querySelector('#dialog-new-session .btn-create').addEventListener('click', () => {
      this.createSession({
        backend: document.getElementById('input-backend').value || 'claude',
        mode: document.getElementById('input-mode').value,
        cwd: document.getElementById('input-cwd').value.trim(),
        name: document.getElementById('input-session-name').value.trim(),
        model: document.getElementById('input-model').value === '__custom__'
          ? (document.getElementById('input-model-custom').value.trim() || '')
          : document.getElementById('input-model').value,
        permission: document.getElementById('input-permission').value,
        effort: document.getElementById('input-effort').value,
        extraArgs: document.getElementById('input-extra-args').value.trim(),
      });
      this.hideDialogs();
    });

    // CWD autocomplete
    this._setupCwdAutocomplete();
  }

  _getBackendSessionDefaults(backend) {
    const prefix = backend === 'codex' ? 'codex' : 'claude';
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
      const label = typeof m === 'string' ? (m || 'Default') : (m.label || m.id || 'Default');
      opt.value = id;
      opt.textContent = label;
      modelSel.appendChild(opt);
      modelIds.push(id);
    }
    // "Custom..." option for free-text model entry
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom...';
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
    setupDirAutocomplete(input, dropdown);
  }

  _showDialog(id) {
    const overlay = document.getElementById('dialog-overlay'); overlay.classList.remove('hidden');
    overlay.querySelectorAll('.dialog').forEach(d => d.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
  }

  showNewSessionDialog() {
    this._showDialog('dialog-new-session');
    document.getElementById('input-backend').value = 'claude';
    this._applySessionBackendOptions('claude', { applyDefaults: true });
    document.getElementById('input-mode').value = this.settings.get('session.defaultMode') ?? 'chat';
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

  createSession({ cwd, name, model, permission, extraArgs, resumeId, mode, syncId, effort, backend = 'claude', backendSessionId, agentKind, agentRole, agentNickname, sourceKind, parentThreadId }) {
    this._hideWelcome();
    const defaults = this._getBackendSessionDefaults(backend);
    const sessionMode = mode || this.settings.get('session.defaultMode') || 'chat';
    const sessionModel = model !== undefined ? model : defaults.model;
    const sessionPermission = permission !== undefined ? permission : defaults.permission;
    const sessionEffort = effort !== undefined ? effort : defaults.effort;
    const sessionExtraArgs = extraArgs !== undefined ? extraArgs : defaults.extraArgs;
    const sessionName = name || (resumeId ? `Resume ${resumeId.substring(0,8)}` : `Session ${this.wm.windowCounter+1}`);
    const sessionKey = backendSessionId || resumeId ? `${backend}:${backendSessionId || resumeId}` : '';
    const winType = sessionMode === 'chat' ? 'chat' : 'terminal';
    const titleMeta = this._buildTitleMeta({ backend, agentKind, agentRole, agentNickname, sourceKind, parentThreadId });
    const winInfo = this.wm.createWindow({ title: sessionName, type: winType, syncId, titleMeta });

    this.ws.send({
      type:'create', backend, mode: sessionMode, cwd: cwd||undefined, sessionName: name||undefined, model: sessionModel||undefined,
      permissionMode: sessionPermission||undefined, effort: sessionEffort||undefined, extraArgs: sessionExtraArgs||undefined,
      agentKind: agentKind || undefined, agentRole: agentRole || undefined, agentNickname: agentNickname || undefined,
      sourceKind: sourceKind || undefined, parentThreadId: parentThreadId || undefined,
      resume: !!resumeId, resumeId: resumeId||undefined, cols:120, rows:30,
    });

    const handler = (msg) => {
      if (msg.type === 'created') {
        // Set openSpec now that we have the server session ID (for cross-client sync)
        winInfo._openSpec = {
          action: 'attachSession',
          serverId: msg.sessionId,
          backend,
          backendSessionId: backendSessionId || resumeId || null,
          sessionKey,
          agentKind: agentKind || 'primary',
          agentRole: agentRole || '',
          agentNickname: agentNickname || '',
          sourceKind: sourceKind || '',
          parentThreadId: parentThreadId || null,
          name: sessionName,
          cwd: msg.cwd || cwd || '',
          mode: sessionMode,
        };
        this.layoutManager.scheduleAutoSave(); // re-broadcast with openSpec
        if (msg.mode === 'chat' || sessionMode === 'chat') {
          const chatView = new ChatView(winInfo, this.ws, msg.sessionId, this);
          this.sessions.set(winInfo.id, chatView);
          winInfo.onClose = () => {
            const shouldKill = (this.settings.get('window.closeBehavior') ?? 'terminate') === 'terminate';
            if (shouldKill) this.ws.send({ type: 'kill', sessionId: msg.sessionId });
            chatView.dispose(); this.sessions.delete(winInfo.id); this._checkWelcome();
          };
          winInfo._notifyChanged = () => this.updateTaskbar();
          // Load JSONL history for resumed sessions
          if (resumeId) {
            fetch(`/api/session-messages?backend=${encodeURIComponent(backend)}&backendSessionId=${encodeURIComponent(backendSessionId || resumeId)}&cwd=${encodeURIComponent(cwd||'')}&withStatus=1`)
              .then(r => r.json())
              .then(data => {
                if (data.messages?.length) chatView.loadHistory(data.messages, data.total);
                if (data.chatStatus) chatView.applyStatus(data.chatStatus);
              })
              .catch(() => {});
          }
          chatView.focus();
        } else {
          const term = new TerminalSession(winInfo, this.ws, msg.sessionId, this.themeManager, (filePath, signalPath) => {
            this._openExternalEditor(filePath, signalPath);
          }, {}, this.settings);
          this.sessions.set(winInfo.id, term);
          this._wireTerminalWindow(winInfo, term, msg.sessionId);
          term.focus();
        }
        this.wm.setTitle(winInfo.id, `${sessionName} — ${msg.cwd||cwd||'~'}`);
        this.ws.offGlobal(handler);
      }
    };
    this.ws.onGlobal(handler);
  }

  _wireTerminalWindow(winInfo, term, sessionId, { killOnClose = true } = {}) {
    winInfo.onClose = () => {
      const shouldKill = killOnClose && (this.settings.get('window.closeBehavior') ?? 'terminate') === 'terminate';
      if (shouldKill) this.ws.send({ type: 'kill', sessionId });
      term.dispose(); this.sessions.delete(winInfo.id); this._checkWelcome();
    };
    winInfo._notifyChanged = () => this.updateTaskbar();
  }

  killSession(webuiId) {
    this.ws.send({ type: 'kill', sessionId: webuiId });
  }

  async killPid(pid) {
    await fetch('/api/kill-pid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }) });
  }

  // Find existing window for a server session ID and focus it
  _focusExistingSession(serverId) {
    for (const [winId, term] of this.sessions) {
      if (term.sessionId === serverId) {
        this.wm.focusWindow(winId);
        if (this.wm.windows.get(winId)?.isMinimized) this.wm.restore(winId);
        term.focus();
        return true;
      }
    }
    return false;
  }

  _closeSidebarOnMobile() {
    if (window.innerWidth <= 768 && this.sidebar.isOpen) this.sidebar.toggle(false);
  }

  attachSession(serverId, name, cwd, { mode, syncId, backend = 'claude', backendSessionId, agentKind, agentRole, agentNickname, sourceKind, parentThreadId } = {}) {
    this._closeSidebarOnMobile();
    // If we already have a window for this session, just focus it
    if (this._focusExistingSession(serverId)) return null;

    this._hideWelcome();
    const isChat = mode === 'chat';
    const openSpec = {
      action: 'attachSession',
      serverId,
      name,
      cwd,
      mode,
      backend,
      backendSessionId: backendSessionId || null,
      sessionKey: backendSessionId ? `${backend}:${backendSessionId}` : '',
      agentKind: agentKind || 'primary',
      agentRole: agentRole || '',
      agentNickname: agentNickname || '',
      sourceKind: sourceKind || '',
      parentThreadId: parentThreadId || null,
    };
    const winInfo = this.wm.createWindow({
      title: `${name} — ${cwd}`,
      type: isChat ? 'chat' : 'terminal',
      syncId,
      openSpec,
      titleMeta: this._buildTitleMeta(openSpec),
    });

    this.ws.send({ type: 'attach', sessionId: serverId });

    const handler = (msg) => {
      if (msg.type === 'attached' && msg.sessionId === serverId) {
        if (msg.mode === 'chat' || isChat) {
          const chatView = new ChatView(winInfo, this.ws, serverId, this);
          this.sessions.set(winInfo.id, chatView);
          if (msg.messages?.length) {
            chatView.loadHistory(msg.messages, msg.totalCount, msg.isStreaming, { chatStatus: msg.chatStatus, taskState: msg.taskState, turnMap: msg.turnMap, pendingPermissions: msg.pendingPermissions });
          }
          if (msg.viewOnly) chatView._setReadOnly();
          winInfo.onClose = () => {
            const shouldKill = !msg.viewOnly && (this.settings.get('window.closeBehavior') ?? 'terminate') === 'terminate';
            if (shouldKill) this.ws.send({ type: 'kill', sessionId: serverId });
            chatView.dispose(); this.sessions.delete(winInfo.id); this._checkWelcome();
          };
          winInfo._notifyChanged = () => this.updateTaskbar();
          chatView.focus();
        } else {
          // Terminal mode (existing)
          const term = new TerminalSession(winInfo, this.ws, serverId, this.themeManager, (fp, sp) => this._openExternalEditor(fp, sp), {}, this.settings);
          this.sessions.set(winInfo.id, term);
          if (msg.buffer) {
            const buf = msg.buffer;
            term._suppressWaiting = true;
            setTimeout(() => { term.terminal.write(buf, () => { term._suppressWaiting = false; term.terminal.scrollToBottom(); term.fit(); }); }, 300);
          }
          this._wireTerminalWindow(winInfo, term, serverId);
          term.focus();
        }
        this.ws.offGlobal(handler);
      }
    };
    this.ws.onGlobal(handler);
    return winInfo;
  }

  attachTmuxSession(tmuxTarget, name, cwd) {
    this._closeSidebarOnMobile();
    // Check if already viewing this tmux target
    for (const [winId, term] of this.sessions) {
      if (term._tmuxTarget === tmuxTarget) {
        this.wm.focusWindow(winId);
        if (this.wm.windows.get(winId)?.isMinimized) this.wm.restore(winId);
        term.focus(); return;
      }
    }

    this._hideWelcome();
    const winInfo = this.wm.createWindow({ title: `[tmux] ${name}`, type: 'terminal' });

    this.ws.send({ type: 'tmux-attach', tmuxTarget, name, cwd, cols: 120, rows: 30 });

    const handler = (msg) => {
      if (msg.type === 'created' && msg.isTmuxView) {
        const term = new TerminalSession(winInfo, this.ws, msg.sessionId, this.themeManager, null, {}, this.settings);
        term._tmuxTarget = tmuxTarget;
        this.sessions.set(winInfo.id, term);
        // Closing window only detaches the tmux view — does NOT kill the session
        this._wireTerminalWindow(winInfo, term, msg.sessionId, { killOnClose: false });
        term.focus();
        this.ws.offGlobal(handler);
      }
    };
    this.ws.onGlobal(handler);
  }

  resumeSession(sessionId, cwd, sessionName, { mode, syncId, backend = 'claude', backendSessionId, agentKind, agentRole, agentNickname, sourceKind, parentThreadId } = {}) {
    this._closeSidebarOnMobile();
    // If this session is already open in a window (e.g. already resumed), just focus it
    for (const [winId, term] of this.sessions) {
      if (term.sessionId) {
        const sidebar = this.sidebar;
        const match = (sidebar._allSessions || []).find(s => (s.backendSessionId || s.sessionId) === (backendSessionId || sessionId) && (s.backend || 'claude') === backend && s.webuiId);
        if (match && term.sessionId === match.webuiId) {
          this._focusExistingSession(match.webuiId);
          return;
        }
      }
    }

    const sessionMode = mode || (this.settings.get('session.defaultMode') ?? 'chat');
    this.createSession({
      cwd,
      name: sessionName,
      resumeId: sessionId,
      mode: sessionMode,
      syncId,
      backend,
      backendSessionId: backendSessionId || sessionId,
      agentKind,
      agentRole,
      agentNickname,
      sourceKind,
      parentThreadId,
    });
  }

  // Open a stopped session as view-only (load JSONL, no claude --resume)
  viewSession(sessionId, cwd, sessionName, { syncId, backend = 'claude', backendSessionId, agentKind, agentRole, agentNickname, sourceKind, parentThreadId } = {}) {
    this._closeSidebarOnMobile();
    this._hideWelcome();
    const resolvedSessionId = backendSessionId || sessionId;
    const viewId = backend === 'claude' ? `view-${resolvedSessionId}` : `view-${backend}-${resolvedSessionId}`;
    const openSpec = {
      action: 'viewSession',
      sessionId,
      backend,
      backendSessionId: resolvedSessionId,
      sessionKey: `${backend}:${resolvedSessionId}`,
      agentKind: agentKind || 'primary',
      agentRole: agentRole || '',
      agentNickname: agentNickname || '',
      sourceKind: sourceKind || '',
      parentThreadId: parentThreadId || null,
      cwd,
      name: sessionName,
    };
    const winInfo = this.wm.createWindow({
      title: `${sessionName || 'History'} — ${cwd}`,
      type: 'chat',
      syncId,
      openSpec,
      titleMeta: this._buildTitleMeta(openSpec),
    });
    const chatView = new ChatView(winInfo, this.ws, viewId, this, { readOnly: true });
    this.sessions.set(winInfo.id, chatView);

    // Request view-only attach — server loads JSONL without spawning claude
    this.ws.send({
      type: 'attach',
      sessionId: viewId,
      viewOnly: true,
      backend,
      backendSessionId: resolvedSessionId,
      claudeSessionId: backend === 'claude' ? resolvedSessionId : undefined,
      cwd,
      name: sessionName,
    });

    const handler = (msg) => {
      if (msg.type === 'attached' && msg.sessionId === viewId) {
        this.ws.offGlobal(handler);
        if (msg.messages?.length) {
          chatView.loadHistory(msg.messages, msg.totalCount, false, { chatStatus: msg.chatStatus });
        }
      }
    };
    this.ws.onGlobal(handler);
    winInfo.onClose = () => { chatView.dispose(); this.sessions.delete(winInfo.id); this._checkWelcome(); };
    winInfo._notifyChanged = () => this.updateTaskbar();
    return winInfo;
  }

  // Replay a serialized openSpec to recreate a window (for cross-client sync)
  replayOpenSpec(spec, syncId) {
    switch (spec.action) {
      case 'attachSession':
        this.attachSession(spec.serverId, spec.name, spec.cwd, {
          mode: spec.mode,
          syncId,
          backend: spec.backend || 'claude',
          backendSessionId: spec.backendSessionId || null,
          agentKind: spec.agentKind,
          agentRole: spec.agentRole,
          agentNickname: spec.agentNickname,
          sourceKind: spec.sourceKind,
          parentThreadId: spec.parentThreadId,
        });
        break;
      case 'openFileExplorer':
        this.openFileExplorer(spec.path, { syncId });
        break;
      case 'openFile':
        this.openFile(spec.path, spec.name, { syncId });
        break;
      case 'openEditor':
        this.openEditor(spec.path, spec.name, { syncId });
        break;
      case 'openBrowser':
        this.openBrowser(spec.url, { syncId });
        break;
      case 'viewSession':
        this.viewSession(spec.sessionId, spec.cwd, spec.name, {
          syncId,
          backend: spec.backend || 'claude',
          backendSessionId: spec.backendSessionId || spec.sessionId,
          agentKind: spec.agentKind,
          agentRole: spec.agentRole,
          agentNickname: spec.agentNickname,
          sourceKind: spec.sourceKind,
          parentThreadId: spec.parentThreadId,
        });
        break;
      case 'viewSubagent': {
        const title = `\uD83E\uDD16 ${spec.description || 'Agent'}`;
        const winInfo = this.wm.createWindow({
          title,
          type: 'chat',
          syncId,
          openSpec: spec,
          titleMeta: this._buildTitleMeta({
            backend: spec.backend || 'claude',
            agentKind: spec.agentKind || 'subagent',
            agentRole: spec.agentRole,
            agentNickname: spec.agentNickname,
            sourceKind: spec.sourceKind,
            parentThreadId: spec.parentThreadId,
          }),
        });
        const view = new ChatView(winInfo, this.ws, spec.virtualId, this, { readOnly: true });
        this.sessions.set(winInfo.id, view);
        this.ws.send({
          type: 'attach',
          sessionId: spec.virtualId,
          parentSessionId: spec.parentSessionId,
          backend: spec.backend || 'claude',
          backendSessionId: spec.backendSessionId || spec.claudeSessionId,
          claudeSessionId: spec.claudeSessionId,
          cwd: spec.cwd,
        });
        const handler = (msg) => {
          if (msg.type === 'attached' && msg.sessionId === spec.virtualId) {
            this.ws.offGlobal(handler);
            if (msg.messages?.length) view.loadHistory(msg.messages, msg.totalCount, msg.isStreaming);
          }
        };
        this.ws.onGlobal(handler);
        winInfo.onClose = () => { view.dispose(); this.sessions.delete(winInfo.id); this._checkWelcome(); };
        break;
      }
    }
  }

  openFileExplorer(startPath, { syncId } = {}) {
    this._hideWelcome();
    const openSpec = { action: 'openFileExplorer', path: startPath };
    const winInfo = this.wm.createWindow({ title: 'File Explorer', type: 'files', syncId, openSpec });
    const explorer = new FileExplorer(winInfo, this, startPath);
    winInfo._explorer = explorer;
    winInfo.onClose = () => this._checkWelcome();
    return winInfo;
  }

  openBrowser(url, opts) { return openBrowserFn(this, url, opts); }

  openFile(filePath, fileName, opts) {
    FileViewer.open(this, filePath, fileName, opts);
  }

  openEditor(filePath, fileName, opts = {}) {
    this._hideWelcome();
    const title = opts._tempFile ? `View: ${fileName}` : filePath;
    const openSpec = opts._tempFile ? undefined : { action: 'openEditor', path: filePath, name: fileName };
    const winInfo = this.wm.createWindow({ title, type: 'editor', syncId: opts.syncId, openSpec });
    winInfo._filePath = filePath; winInfo._fileName = fileName;
    new CodeEditor(winInfo, filePath, fileName, this, opts);
    winInfo.onClose = () => {
      if (opts._onCloseDelete) opts._onCloseDelete();
      this._checkWelcome();
    };
  }

  // Delegate to extracted external-editor.js module
  _openExternalEditor(filePath, signalPath, sessionId) { openExternalEditor(this, filePath, signalPath, sessionId); }
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

  // Flash a window's title bar + taskbar item to help user find it
  flashWindow(serverSessionId) {
    for (const [winId, term] of this.sessions) {
      if (term.sessionId === serverSessionId) {
        const win = this.wm.windows.get(winId);
        if (!win) break;
        win.element.classList.add('window-find-flash');
        // Flash matching taskbar item
        const taskbarItems = document.querySelectorAll('.taskbar-item');
        const idx = [...this.wm.windows.keys()].indexOf(winId);
        const taskbarItem = taskbarItems[idx];
        if (taskbarItem) taskbarItem.classList.add('find-flash');
        // Restore if minimized + bring to front
        if (win.isMinimized) this.wm.restore(winId);
        this.wm.focusWindow(winId);
        // Remove flash after 3 seconds
        setTimeout(() => {
          win.element.classList.remove('window-find-flash');
          if (taskbarItem) taskbarItem.classList.remove('find-flash');
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
    for (const [winId, session] of this.sessions) {
      const win = this.wm.windows.get(winId);
      if (!win) continue;
      const spec = win._openSpec || {};
      const match = allSessions.find((entry) => {
        if (entry.webuiId && session.sessionId === entry.webuiId) return true;
        const entryKey = entry.sessionKey || `${entry.backend || 'claude'}:${entry.backendSessionId || entry.sessionId}`;
        const specKey = spec.sessionKey || `${spec.backend || win.titleMeta?.backend || 'claude'}:${spec.backendSessionId || spec.sessionId || ''}`;
        return !!(spec.sessionKey || spec.backendSessionId || spec.sessionId) && entryKey === specKey;
      });
      if (!match) continue;
      this.wm.setTitleMeta(winId, this._buildTitleMeta(match));
      if (win._openSpec) {
        Object.assign(win._openSpec, {
          backend: match.backend || win._openSpec.backend || 'claude',
          backendSessionId: match.backendSessionId || match.sessionId,
          sessionKey: match.sessionKey || getSessionKey(match),
          name: match.name || win._openSpec.name || '',
          agentKind: match.agentKind || 'primary',
          agentRole: match.agentRole || '',
          agentNickname: match.agentNickname || '',
          sourceKind: match.sourceKind || '',
          parentThreadId: match.parentThreadId || null,
        });
      }
      if (win._openSpec?.action === 'viewSession' || win._openSpec?.action === 'attachSession') {
        const displayName = match.webuiName || match.name || win._openSpec?.name || win.title || 'Session';
        const cwd = match.cwd || win._openSpec?.cwd || '';
        this.wm.setTitle(winId, cwd ? `${displayName} — ${cwd}` : displayName);
      }
    }
  }

  _notifySidebarFocus() {
    // Find the claude session ID for the currently focused terminal window
    const activeWinId = this.wm.activeWindowId;
    const term = this.sessions.get(activeWinId);
    if (term && term.sessionId) {
      const allSess = this.sidebar?._allSessions || [];
      const match = allSess.find(s => s.webuiId === term.sessionId);
      if (match) {
        this.sidebar.highlightSession(match.sessionId);
        return;
      }
    }
    // No terminal focused — clear highlight
    this.sidebar.highlightSession(null);
  }

  updateTaskbar() { updateTaskbarFn(this); if (this.desktopManager) this.desktopManager._renderSwitcher(); }

  _showWindowList(anchor) { showWindowList(this, anchor); }

  _populateThemeSelect(sel) {
    sel.innerHTML = '';
    const opt = (v, l) => { const o = document.createElement('option'); o.value = v; o.textContent = l; return o; };
    for (const name of BUILTIN_THEMES) sel.appendChild(opt(name, name.charAt(0).toUpperCase() + name.slice(1)));
    const customKeys = this.themeManager.getThemeNames().filter(n => n.startsWith('custom-'));
    if (customKeys.length) {
      const sep = document.createElement('option'); sep.disabled = true; sep.textContent = '── Custom ──'; sel.appendChild(sep);
      for (const key of customKeys) sel.appendChild(opt(key, key.slice(7)));
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
