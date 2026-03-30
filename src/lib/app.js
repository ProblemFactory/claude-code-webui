import { ThemeManager, THEMES } from './themes.js';
import { WsManager } from './ws.js';
import { WindowManager } from './window.js';
import { TerminalSession } from './terminal.js';
import { Sidebar } from './sidebar.js';
import { FileExplorer } from './file-explorer.js';
import { FileViewer } from './file-viewer.js';
import { CodeEditor, detectLang, getLangExtension, loadEditorSettings, saveEditorSettings, editorLightTheme } from './code-editor.js';
import { LayoutManager } from './layout.js';
import { Resizer } from './resizer.js';
import { attachPopoverClose } from './utils.js';
import { setupDirAutocomplete } from './autocomplete.js';
import { getAvailableFonts } from './terminal.js';
import { SettingsManager } from './settings.js';
import { SettingsUI } from './settings-ui.js';
import { EditorView, basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';

class App {
  constructor() {
    this.settings = new SettingsManager();
    this.themeManager = new ThemeManager();
    this.ws = new WsManager();
    this.wm = new WindowManager(document.getElementById('workspace'));
    this.wm._settings = this.settings;
    this.sessions = new Map();
    this.attachedServerSessions = new Set();
    this.layoutManager = new LayoutManager(this);

    this.wm.onWindowsChanged = () => {
      this.updateTaskbar();
      this.layoutManager.scheduleAutoSave();
      this._notifySidebarFocus();
    };
    this.sidebar = new Sidebar(this);

    // Load settings asynchronously (non-blocking — modules use defaults until loaded)
    this.settings.load();

    // Sync settings from other clients via WebSocket
    this.ws.onGlobal((msg) => {
      if (msg.type === 'settings-updated' && msg.settings) {
        this.settings.applyRemote(msg.settings);
      }
    });

    this._setupToolbar();
    this._setupDialogs();
    this._setupWelcome();
    this._setupGlobalSettings();
    this._setupGridConfig();
    this._setupLayoutManager();
    this._setupUsage();
    this._setupCommandMode();

    // Listen for editor open/close requests (from editor-helper.sh via server HTTP→WebSocket)
    this.ws.onGlobal((msg) => {
      if (msg.type === 'editor-open' && msg.filePath && msg.signalPath) {
        this._openExternalEditor(msg.filePath, msg.signalPath, msg.sessionId);
      } else if (msg.type === 'editor-close' && msg.signalPath) {
        this._closeExternalEditor(msg.signalPath);
      }
    });

    fetch('/api/home').then(r=>r.json()).then(d=> { document.getElementById('input-cwd').placeholder = d.home; }).catch(()=>{});

    // Restore layout after WebSocket is connected (needs active sessions)
    setTimeout(() => this.layoutManager.loadAutoSave(), 1500);
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
    document.querySelectorAll('.global-settings-popover').forEach(p => p.remove());

    const pop = document.createElement('div');
    pop.className = 'global-settings-popover';
    const rect = anchor.getBoundingClientRect();
    pop.style.top = (rect.bottom + 4) + 'px';
    pop.style.right = (window.innerWidth - rect.right) + 'px';

    const opt = (v, l) => { const o = document.createElement('option'); o.value = v; o.textContent = l; return o; };

    // Theme
    const themeLabel = document.createElement('label'); themeLabel.textContent = 'Theme';
    const themeSel = document.createElement('select');
    for (const name of Object.keys(THEMES)) { themeSel.appendChild(opt(name, name.charAt(0).toUpperCase() + name.slice(1))); }
    themeSel.value = this.themeManager.current;
    themeSel.onchange = () => {
      this.themeManager.apply(themeSel.value);
      for (const [, term] of this.sessions) term.updateTheme(this.themeManager.getTerminalTheme());
    };

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
      for (const [, term] of this.sessions) {
        if (!term.overrides.fontSize) {
          term.terminal.options.fontSize = this._fontSize;
          try { term.terminal.clearTextureAtlas(); } catch {}
          term.fit();
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
      for (const [, term] of this.sessions) {
        if (!term.overrides.fontFamily) {
          term.terminal.options.fontFamily = this._fontFamily;
          try { term.terminal.clearTextureAtlas(); } catch {}
          term.fit();
        }
      }
    };

    // "All Settings" link
    const allSettingsLink = document.createElement('div');
    allSettingsLink.className = 'settings-all-link';
    allSettingsLink.textContent = 'All Settings...';
    allSettingsLink.onclick = () => { pop.remove(); this._settingsUI.open(); };

    pop.append(themeLabel, themeSel, sizeLabel, sizeRow, fontLabel, fontSel, allSettingsLink);
    document.body.appendChild(pop);

    attachPopoverClose(pop, anchor);
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
    try {
      const res = await fetch('/api/layouts');
      const data = await res.json();
      const grids = data.customGrids || [];
      this._customGrids = grids;
      this._renderCustomGridButtons();
    } catch {}
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
    try {
      const res = await fetch('/api/custom-grids', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, cols }),
      });
      const data = await res.json();
      this._customGrids = data.customGrids || [];
      this._renderCustomGridButtons();
    } catch {}
  }

  async _removeCustomGrid(rows, cols) {
    try {
      const res = await fetch('/api/custom-grids', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, cols }),
      });
      const data = await res.json();
      this._customGrids = data.customGrids || [];
      this._renderCustomGridButtons();
    } catch {}
  }

  _setupUsage() {
    this._usageData = new Map(); // sessionId → usage
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
    try {
      const res = await fetch('/api/usage');
      const data = await res.json();
      this._rateLimit = data.rateLimit;
    } catch { this._rateLimit = null; }
    this._renderUsage();
    setTimeout(() => this._pollUsage(), 30000);
  }

  _renderUsage() {
    const usageEl = document.getElementById('taskbar-usage');
    const popup = document.getElementById('usage-popup');
    const rl = this._rateLimit;

    if (!rl) {
      usageEl.innerHTML = '';
      popup.innerHTML = '<div class="empty-hint">No usage data</div>';
      return;
    }

    // Taskbar: 5h progress bar + percentage
    const pct5h = Math.round((rl.fiveHour?.utilization || 0) * 100);
    const color = pct5h > 80 ? 'var(--red)' : pct5h > 50 ? 'var(--yellow)' : 'var(--green)';
    usageEl.innerHTML = `<div class="usage-bar"><div class="usage-bar-fill" style="width:${pct5h}%;background:${color}"></div></div><span>${pct5h}%</span>`;

    // Popup: match Claude Code /usage layout
    const pct7d = Math.round((rl.sevenDay?.utilization || 0) * 100);
    const color7d = pct7d > 80 ? 'var(--red)' : pct7d > 50 ? 'var(--yellow)' : 'var(--green)';
    const fmtReset = (ts) => {
      if (!ts) return '?';
      const d = new Date(ts * 1000), now = new Date();
      const time = d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
      if (d.toDateString() === now.toDateString()) return `Today ${time}`;
      const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
      if (d.toDateString() === tmr.toDateString()) return `Tomorrow ${time}`;
      return d.toLocaleDateString([], {month:'short',day:'numeric'}) + ' ' + time;
    };
    const status = rl.overallStatus === 'allowed' ? '🟢' : '🔴';
    const ago = rl.fetchedAt ? Math.round((Date.now() - rl.fetchedAt) / 60000) : 0;

    popup.innerHTML = `<h4>${status} Usage</h4>
      <div class="usage-session">
        <div class="usage-session-name">Current session</div>
        <div class="usage-bar" style="width:100%;margin:4px 0"><div class="usage-bar-fill" style="width:${pct5h}%;background:${color}"></div></div>
        <div class="usage-session-stats">
          <span class="usage-stat">${pct5h}% used</span>
          <span class="usage-stat"><span class="usage-stat-label">Resets</span> ${fmtReset(rl.fiveHour?.resetsAt)}</span>
        </div>
      </div>
      <div class="usage-session">
        <div class="usage-session-name">Current week (all models)</div>
        <div class="usage-bar" style="width:100%;margin:4px 0"><div class="usage-bar-fill" style="width:${pct7d}%;background:${color7d}"></div></div>
        <div class="usage-session-stats">
          <span class="usage-stat">${pct7d}% used</span>
          <span class="usage-stat"><span class="usage-stat-label">Resets</span> ${fmtReset(rl.sevenDay?.resetsAt)}</span>
        </div>
      </div>
      <div class="usage-total" style="font-weight:400;color:var(--text-dim)">Updated ${ago < 1 ? 'just now' : ago + 'min ago'}</div>`;
  }

  // ── Command Mode (Ctrl+\ prefix key, tmux-style) ──
  _setupCommandMode() {
    this._cmdMode = false;
    this._cmdTimer = null;
    this._cmdDigits = '';
    this._cmdDigitTimer = null;
    this._cmdIndicator = document.getElementById('cmd-indicator');

    document.addEventListener('keydown', (e) => {
      // Ctrl+\ toggles command mode (if enabled in settings)
      if (e.key === '\\' && e.ctrlKey && !e.altKey && !e.metaKey && (this.settings.get('toolbar.showCommandMode') ?? true)) {
        e.preventDefault();
        e.stopPropagation();
        if (this._cmdMode) {
          this._exitCommandMode();
        } else {
          this._enterCommandMode();
        }
        return;
      }

      if (!this._cmdMode) return;

      // Reset the auto-exit timer on each key press in command mode
      this._resetCmdTimer();

      const key = e.key;

      // Esc exits command mode
      if (key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        this._exitCommandMode();
        return;
      }

      // Digit accumulation for cell snap
      if (key >= '0' && key <= '9') {
        e.preventDefault(); e.stopPropagation();
        this._cmdDigits += key;
        clearTimeout(this._cmdDigitTimer);
        this._cmdDigitTimer = setTimeout(() => this._executeCellSnap(), 500);
        return;
      }

      // If we were accumulating digits and a non-digit came, execute the snap first
      if (this._cmdDigits) {
        clearTimeout(this._cmdDigitTimer);
        this._executeCellSnap();
        // Don't return — continue processing the non-digit key below
        // But command mode may have been exited by _executeCellSnap, so re-check
        if (!this._cmdMode) return;
      }

      e.preventDefault(); e.stopPropagation();

      // Window commands (require active window)
      const activeWin = this.wm.windows.get(this.wm.activeWindowId);

      switch (key) {
        case 'ArrowLeft':
          if (activeWin) this.wm.snapToHalf(this.wm.activeWindowId, 'left');
          this._exitCommandMode();
          break;
        case 'ArrowRight':
          if (activeWin) this.wm.snapToHalf(this.wm.activeWindowId, 'right');
          this._exitCommandMode();
          break;
        case 'ArrowUp':
          if (activeWin) this.wm.snapToHalf(this.wm.activeWindowId, 'top');
          this._exitCommandMode();
          break;
        case 'ArrowDown':
          if (activeWin) this.wm.snapToHalf(this.wm.activeWindowId, 'bottom');
          this._exitCommandMode();
          break;
        case 'm':
          if (activeWin) this.wm.toggleMaximize(this.wm.activeWindowId);
          this._exitCommandMode();
          break;
        case 'w':
          if (activeWin) this.wm.closeWindow(this.wm.activeWindowId);
          this._exitCommandMode();
          break;
        case 'Tab':
          // Cycle to next window, STAY in command mode
          if (this.wm.windows.size > 0) {
            const ids = [...this.wm.windows.keys()];
            const curIdx = ids.indexOf(this.wm.activeWindowId);
            const nextIdx = (curIdx + 1) % ids.length;
            const nextId = ids[nextIdx];
            const nextWin = this.wm.windows.get(nextId);
            if (nextWin && nextWin.isMinimized) this.wm.restore(nextId);
            else this.wm.focusWindow(nextId);
            const session = this.sessions.get(nextId);
            if (session) session.focus();
          }
          // Don't exit command mode for Tab
          break;
        case 'f':
          this.wm.applyLayout('freeform');
          this._exitCommandMode();
          break;
        case 'g': {
          this._exitCommandMode();
          const input = prompt('Grid (e.g. 3x3):');
          if (input) {
            const match = input.match(/(\d+)\s*[x×X]\s*(\d+)/);
            if (match) {
              this.wm.setGrid(parseInt(match[1]), parseInt(match[2]));
            }
          }
          break;
        }
        case 'n':
          this._exitCommandMode();
          this.showNewSessionDialog();
          break;
        case 's':
          document.getElementById('sidebar').classList.toggle('open');
          this._exitCommandMode();
          break;
        case 'b':
          this.openBrowser();
          this._exitCommandMode();
          break;
        case 'e':
          this.openFileExplorer();
          this._exitCommandMode();
          break;
        default:
          // Unrecognized key — exit command mode
          this._exitCommandMode();
          break;
      }
    }, true); // capture phase
  }

  _enterCommandMode() {
    this._cmdMode = true;
    this._cmdDigits = '';
    clearTimeout(this._cmdDigitTimer);
    this._cmdIndicator.classList.add('active');
    this._resetCmdTimer();
  }

  _exitCommandMode() {
    this._cmdMode = false;
    this._cmdDigits = '';
    clearTimeout(this._cmdTimer);
    clearTimeout(this._cmdDigitTimer);
    this._cmdIndicator.classList.remove('active');
  }

  _resetCmdTimer() {
    clearTimeout(this._cmdTimer);
    this._cmdTimer = setTimeout(() => this._exitCommandMode(), 2000);
  }

  _executeCellSnap() {
    const cellIdx = parseInt(this._cmdDigits, 10) - 1; // 1-based input → 0-based index
    this._cmdDigits = '';
    if (cellIdx >= 0) {
      this.wm.snapActiveToCell(cellIdx);
    }
    this._exitCommandMode();
  }

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

    document.querySelector('#dialog-new-session .btn-create').addEventListener('click', () => {
      this.createSession({
        cwd: document.getElementById('input-cwd').value.trim(),
        name: document.getElementById('input-session-name').value.trim(),
        model: document.getElementById('input-model').value,
        permission: document.getElementById('input-permission').value,
        extraArgs: document.getElementById('input-extra-args').value.trim(),
      });
      this.hideDialogs();
    });

    // CWD autocomplete
    this._setupCwdAutocomplete();
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

  showNewSessionDialog() { this._showDialog('dialog-new-session'); document.getElementById('input-cwd').focus(); }
  hideDialogs() { document.getElementById('dialog-overlay').classList.add('hidden'); document.getElementById('dialog-overlay').querySelectorAll('.dialog').forEach(d => d.classList.add('hidden')); }

  createSession({ cwd, name, model, permission, extraArgs, resumeId }) {
    this._hideWelcome();
    const sessionName = name || (resumeId ? `Resume ${resumeId.substring(0,8)}` : `Session ${this.wm.windowCounter+1}`);
    const winInfo = this.wm.createWindow({ title: sessionName, type: 'terminal' });

    this.ws.send({
      type:'create', cwd: cwd||undefined, sessionName: name||undefined, model: model||undefined,
      permissionMode: permission||undefined, extraArgs: extraArgs||undefined,
      resume: !!resumeId, resumeId: resumeId||undefined, cols:120, rows:30,
    });

    const handler = (msg) => {
      if (msg.type === 'created') {
        const term = new TerminalSession(winInfo, this.ws, msg.sessionId, this.themeManager, (filePath, signalPath) => {
          this._openExternalEditor(filePath, signalPath);
        }, {}, this.settings);
        this.sessions.set(winInfo.id, term);
        this._wireTerminalWindow(winInfo, term, msg.sessionId);
        this.wm.setTitle(winInfo.id, `${sessionName} — ${msg.cwd||cwd||'~'}`);
        term.focus();
        this.ws.offGlobal(handler);
      }
    };
    this.ws.onGlobal(handler);
  }

  _wireTerminalWindow(winInfo, term, sessionId, { killOnClose = true } = {}) {
    winInfo.onClose = () => {
      if (killOnClose) this.ws.send({ type: 'kill', sessionId });
      term.dispose(); this.sessions.delete(winInfo.id); this._checkWelcome();
    };
    winInfo._notifyChanged = () => this.updateTaskbar();
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

  attachSession(serverId, name, cwd) {
    // If we already have a window for this session, just focus it
    if (this._focusExistingSession(serverId)) return null;

    this._hideWelcome();
    const winInfo = this.wm.createWindow({ title: `${name} — ${cwd}`, type: 'terminal' });

    this.ws.send({ type: 'attach', sessionId: serverId });

    const handler = (msg) => {
      if (msg.type === 'attached' && msg.sessionId === serverId) {
        const term = new TerminalSession(winInfo, this.ws, serverId, this.themeManager, (fp, sp) => this._openExternalEditor(fp, sp), {}, this.settings);
        this.sessions.set(winInfo.id, term);
        // Write saved buffer after terminal is fully initialized
        if (msg.buffer) {
          const buf = msg.buffer;
          term._suppressWaiting = true;
          setTimeout(() => { term.terminal.write(buf, () => { term._suppressWaiting = false; term.terminal.scrollToBottom(); term.fit(); }); }, 300);
        }
        this._wireTerminalWindow(winInfo, term, serverId);
        term.focus();
        this.ws.offGlobal(handler);
      }
    };
    this.ws.onGlobal(handler);
    return winInfo;
  }

  attachTmuxSession(tmuxTarget, name, cwd) {
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

  resumeSession(sessionId, cwd, sessionName) {
    // If this session is already open in a window (e.g. already resumed), just focus it
    for (const [winId, term] of this.sessions) {
      // Match by the claude session ID stored on the server
      if (term.sessionId) {
        // We need to check the server's active sessions to see if this term's webui session
        // corresponds to the claude sessionId we want
        const sidebar = this.sidebar;
        const match = (sidebar._allSessions || []).find(s => s.sessionId === sessionId && s.webuiId);
        if (match && term.sessionId === match.webuiId) {
          this._focusExistingSession(match.webuiId);
          return;
        }
      }
    }

    this._hideWelcome();
    const cwdShort = (cwd || '').replace(/^\/home\/[^/]+/, '~');
    const title = sessionName || cwdShort;
    const winInfo = this.wm.createWindow({ title, type: 'terminal' });

    this.ws.send({
      type: 'create', cwd: cwd || undefined,
      sessionName: title,
      resume: true, resumeId: sessionId,
      cols: 120, rows: 30,
    });

    const handler = (msg) => {
      if (msg.type === 'created') {
        const serverSessId = msg.sessionId;
        const term = new TerminalSession(winInfo, this.ws, serverSessId, this.themeManager, (fp, sp) => this._openExternalEditor(fp, sp), {}, this.settings);
        this.sessions.set(winInfo.id, term);
        this._wireTerminalWindow(winInfo, term, serverSessId);
        term.focus();
        this.ws.offGlobal(handler);
      }
    };
    this.ws.onGlobal(handler);
  }

  openFileExplorer(startPath) {
    this._hideWelcome();
    const winInfo = this.wm.createWindow({ title: 'File Explorer', type: 'files' });
    const explorer = new FileExplorer(winInfo, this, startPath);
    winInfo.onClose = () => this._checkWelcome();
    return winInfo;
  }

  openBrowser(url) {
    this._hideWelcome();
    const startUrl = url || '';
    const winInfo = this.wm.createWindow({ title: startUrl ? new URL(startUrl).hostname : 'Browser', type: 'browser' });
    const container = document.createElement('div');
    container.style.cssText = 'display:flex;flex-direction:column;height:100%';

    // URL bar
    const urlBar = document.createElement('div');
    urlBar.style.cssText = 'display:flex;gap:4px;padding:4px 6px;border-bottom:1px solid var(--border);background:var(--bg-titlebar);flex-shrink:0';
    const urlInput = document.createElement('input');
    urlInput.className = 'file-path-input';
    urlInput.value = startUrl;
    urlInput.placeholder = 'Enter URL...';
    const goBtn = document.createElement('button');
    goBtn.className = 'file-tool-btn'; goBtn.textContent = '→'; goBtn.title = 'Go';
    goBtn.style.width = '28px';
    let proxyMode = false;
    const proxyBtn = document.createElement('button');
    proxyBtn.className = 'file-tool-btn'; proxyBtn.title = 'Proxy mode (bypass X-Frame-Options)';
    proxyBtn.style.cssText = 'width:auto;padding:0 6px;font-size:10px';
    proxyBtn.textContent = 'Proxy: Off';
    proxyBtn.onclick = () => {
      proxyMode = !proxyMode;
      proxyBtn.textContent = proxyMode ? 'Proxy: On' : 'Proxy: Off';
      proxyBtn.style.color = proxyMode ? 'var(--accent)' : '';
      // Re-navigate with new mode
      if (urlInput.value) navigate(urlInput.value);
    };
    const openExtBtn = document.createElement('button');
    openExtBtn.className = 'file-tool-btn'; openExtBtn.textContent = '↗'; openExtBtn.title = 'Open in new tab';
    openExtBtn.style.width = '28px';
    openExtBtn.onclick = () => { if (urlInput.value) window.open(urlInput.value, '_blank'); };
    urlBar.append(urlInput, goBtn, proxyBtn, openExtBtn);

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'flex:1;border:none;width:100%;background:#fff';
    // No sandbox for maximum compatibility — same-origin pages (noVNC, local services) work fully
    // External sites may still block via X-Frame-Options (browser security, can't bypass)

    const errorMsg = document.createElement('div');
    errorMsg.style.cssText = 'display:none;flex:1;padding:20px;text-align:center;color:var(--text-dim);font-size:12px';

    const navigate = (u) => {
      if (!u) return;
      if (!u.match(/^https?:\/\//)) u = 'http://' + u;
      urlInput.value = u;
      errorMsg.style.display = 'none';
      iframe.style.display = '';
      iframe.src = proxyMode ? `/proxy/${u}` : u;
      try { this.wm.setTitle(winInfo.id, new URL(u).hostname); } catch {}
      winInfo._browserUrl = u;
    };

    // Detect load failures (X-Frame-Options, CSP, etc.)
    iframe.addEventListener('load', () => {
      try { iframe.contentWindow.document; } catch {
        // Cross-origin blocked — show error
        errorMsg.innerHTML = `<p>This site blocked iframe embedding (X-Frame-Options).</p><p style="margin-top:8px"><a href="${urlInput.value}" target="_blank" style="color:var(--accent)">Open in new tab ↗</a></p><p style="margin-top:12px;font-size:11px;opacity:0.6">Tip: Same-origin pages (noVNC, local services) work fine in this browser.</p>`;
        errorMsg.style.display = '';
        iframe.style.display = 'none';
      }
    });

    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(urlInput.value); });
    goBtn.onclick = () => navigate(urlInput.value);

    container.append(urlBar, iframe, errorMsg);
    winInfo.content.appendChild(container);
    winInfo.onClose = () => this._checkWelcome();

    if (startUrl) navigate(startUrl);
    return winInfo;
  }

  openFile(filePath, fileName, opts) {
    FileViewer.open(this, filePath, fileName, opts);
  }

  openEditor(filePath, fileName, opts = {}) {
    this._hideWelcome();
    const winInfo = this.wm.createWindow({ title: `Edit: ${fileName}`, type: 'editor' });
    winInfo._filePath = filePath; winInfo._fileName = fileName;
    new CodeEditor(winInfo, filePath, fileName, this, opts);
    winInfo.onClose = () => this._checkWelcome();
  }

  _openExternalEditor(filePath, signalPath, sessionId) {
    // Find the terminal window that triggered this — match by webui session ID
    let targetWinInfo = null;
    if (sessionId) {
      for (const [winId, win] of this.wm.windows) {
        const term = this.sessions.get(winId);
        if (term && term.sessionId === sessionId) { targetWinInfo = win; break; }
      }
    }
    // Fallback: active window, then any terminal
    if (!targetWinInfo) {
      for (const [winId, win] of this.wm.windows) {
        if (win.type === 'terminal' && winId === this.wm.activeWindowId) { targetWinInfo = win; break; }
      }
    }
    if (!targetWinInfo) {
      for (const [, win] of this.wm.windows) { if (win.type === 'terminal') { targetWinInfo = win; break; } }
    }

    if (!targetWinInfo) {
      // No terminal window — open standalone editor
      this._hideWelcome();
      const winInfo = this.wm.createWindow({ title: `Editor: ${filePath.split('/').pop()}`, type: 'editor' });
      new CodeEditor(winInfo, filePath, filePath.split('/').pop(), this, {
        onSaveAndClose: async () => {
          try { await fetch('/api/editor/signal', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ signalPath, filePath }) }); } catch {}
        },
      });
      return;
    }

    // Split the terminal window: add an editor pane below the terminal
    const contentEl = targetWinInfo.content;
    const termContainer = contentEl.querySelector('.terminal-container');
    if (!termContainer) return;

    // Create split layout
    contentEl.style.display = 'flex';
    contentEl.style.flexDirection = 'column';
    termContainer.style.flex = '1';
    termContainer.style.minHeight = '100px';

    // Store editor state on winInfo for layout save/restore
    targetWinInfo._editorState = { filePath, signalPath };

    // Create the editor pane
    const editorPane = document.createElement('div');
    editorPane.className = 'editor-container';
    editorPane.style.flex = '1';
    editorPane.style.borderTop = '2px solid var(--accent)';
    editorPane.style.minHeight = '150px';

    // Editor toolbar with settings
    const toolbar = document.createElement('div');
    toolbar.className = 'editor-toolbar';
    toolbar.innerHTML = `<span class="file-path">${filePath}</span>`;

    const edSettings = loadEditorSettings();
    const mkBtn = (text) => { const b = document.createElement('button'); b.className = 'editor-setting-btn'; b.textContent = text; return b; };

    // Wrap toggle
    const btnWrap = mkBtn(edSettings.wordWrap ? 'Wrap: On' : 'Wrap: Off');
    // Font size
    const btnFontDown = mkBtn('A-');
    const fontDisplay = document.createElement('span'); fontDisplay.className = 'editor-font-size-display'; fontDisplay.textContent = edSettings.fontSize;
    const btnFontUp = mkBtn('A+');
    // Theme toggle
    const btnTheme = mkBtn(edSettings.theme === 'dark' ? 'Dark' : 'Light');

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-create';
    saveBtn.style.cssText = 'padding:3px 12px;font-size:11px;';
    saveBtn.textContent = 'Save & Close';

    const sep = document.createElement('span'); sep.className = 'editor-toolbar-sep';
    toolbar.append(sep, btnWrap, btnFontDown, fontDisplay, btnFontUp, btnTheme, saveBtn);

    const editorBody = document.createElement('div');
    editorBody.className = 'editor-body';
    editorPane.append(toolbar, editorBody);
    contentEl.appendChild(editorPane);

    // Draggable divider between terminal and editor (vertical resize)
    const splitResizer = new Resizer(termContainer, 'vertical', {
      min: 80, max: 1000,
      onResize: () => { if (termSession) termSession.fit(); },
    });

    // Resize terminal to fit the new split
    const termSession = [...this.sessions.values()].find(s => {
      return s.winInfo === targetWinInfo;
    }) || [...this.sessions.values()][0];
    if (termSession) setTimeout(() => termSession.fit(), 100);

    // Load file and create CodeMirror editor
    fetch(`/api/file/content?path=${encodeURIComponent(filePath)}`)
      .then(r => r.json())
      .then(data => {
        const content = data.content || '';
        const langExtensions = getLangExtension(detectLang(filePath));
        const edSettings = loadEditorSettings();

        const themeComp = new Compartment();
        const wrapComp = new Compartment();
        const fontSizeComp = new Compartment();

        const editorView = new EditorView({
          state: EditorState.create({
            doc: content,
            extensions: [
              basicSetup,
              themeComp.of(edSettings.theme === 'dark' ? oneDark : editorLightTheme),
              wrapComp.of(edSettings.wordWrap ? EditorView.lineWrapping : []),
              fontSizeComp.of(EditorView.theme({ '.cm-content, .cm-gutters': { fontSize: edSettings.fontSize + 'px' } })),
              ...langExtensions,
              Prec.highest(keymap.of([
                { key: 'Mod-s', run: () => { doSave(); return true; } },
                { key: 'Mod-g', run: () => { doSave(); return true; } },
              ])),
              keymap.of([indentWithTab]),
            ],
          }),
          parent: editorBody,
        });

        // Wire up editor settings buttons
        btnWrap.onclick = () => {
          edSettings.wordWrap = !edSettings.wordWrap;
          btnWrap.textContent = edSettings.wordWrap ? 'Wrap: On' : 'Wrap: Off';
          editorView.dispatch({ effects: wrapComp.reconfigure(edSettings.wordWrap ? EditorView.lineWrapping : []) });
          saveEditorSettings(edSettings);
        };
        btnFontDown.onclick = () => {
          edSettings.fontSize = Math.max(8, edSettings.fontSize - 1);
          fontDisplay.textContent = edSettings.fontSize;
          editorView.dispatch({ effects: fontSizeComp.reconfigure(EditorView.theme({ '.cm-content, .cm-gutters': { fontSize: edSettings.fontSize + 'px' } })) });
          saveEditorSettings(edSettings);
        };
        btnFontUp.onclick = () => {
          edSettings.fontSize = Math.min(32, edSettings.fontSize + 1);
          fontDisplay.textContent = edSettings.fontSize;
          editorView.dispatch({ effects: fontSizeComp.reconfigure(EditorView.theme({ '.cm-content, .cm-gutters': { fontSize: edSettings.fontSize + 'px' } })) });
          saveEditorSettings(edSettings);
        };
        btnTheme.onclick = () => {
          edSettings.theme = edSettings.theme === 'dark' ? 'light' : 'dark';
          btnTheme.textContent = edSettings.theme === 'dark' ? 'Dark' : 'Light';
          editorView.dispatch({ effects: themeComp.reconfigure(edSettings.theme === 'dark' ? oneDark : editorLightTheme) });
          saveEditorSettings(edSettings);
        };

        const doSave = async () => {
          const newContent = editorView.state.doc.toString();
          try {
            await fetch('/api/file/write', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: filePath, content: newContent }) });
            await fetch('/api/editor/signal', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ signalPath, filePath }) });
          } catch {}
          // Remove editor pane + resizer, restore terminal to full height
          targetWinInfo._editorState = null;
          targetWinInfo._editorDoSave = null;
          editorView.destroy();
          splitResizer.destroy();
          editorPane.remove();
          contentEl.style.display = '';
          contentEl.style.flexDirection = '';
          termContainer.style.flex = '';
          termContainer.style.minHeight = '';
          termContainer.style.height = '';
          termContainer.style.flexBasis = '';
          if (termSession) {
            setTimeout(() => {
              termSession.fit();
              // Scroll to bottom and re-focus terminal
              termSession.terminal.scrollToBottom();
              termSession.terminal.focus();
            }, 150);
          }
        };

        saveBtn.onclick = doSave;
        targetWinInfo._editorDoSave = doSave;
      });
  }

  _closeExternalEditor(signalPath) {
    // Find the window with this editor and close the split pane
    for (const [, win] of this.wm.windows) {
      if (win._editorState?.signalPath === signalPath) {
        const editorPane = win.content.querySelector('.editor-container');
        const termContainer = win.content.querySelector('.terminal-container');
        if (editorPane) {
          editorPane.remove();
          win._editorState = null;
          if (termContainer) {
            win.content.style.display = '';
            win.content.style.flexDirection = '';
            termContainer.style.flex = '';
            termContainer.style.minHeight = '';
            termContainer.style.height = '';
            termContainer.style.flexBasis = '';
          }
          const termSession = [...this.sessions.values()].find(s => s.winInfo === win);
          if (termSession) {
            setTimeout(() => { termSession.fit(); termSession.terminal.scrollToBottom(); }, 150);
          }
        }
        break;
      }
    }
  }

  _hideWelcome() { document.getElementById('welcome').classList.add('hidden'); }
  _checkWelcome() { if (this.wm.windows.size === 0) document.getElementById('welcome').classList.remove('hidden'); }

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
        // Restore if minimized
        if (win.isMinimized) this.wm.restore(winId);
        // Remove flash after 3 seconds
        setTimeout(() => {
          win.element.classList.remove('window-find-flash');
          if (taskbarItem) taskbarItem.classList.remove('find-flash');
        }, 3000);
        break;
      }
    }
  }

  syncSessionName(claudeSessionId, newName) {
    // Find the open window whose server session corresponds to this claude session ID
    for (const [winId, term] of this.sessions) {
      if (!term.sessionId) continue;
      const allSess = this.sidebar?._allSessions || [];
      const match = allSess.find(s => s.sessionId === claudeSessionId && s.webuiId === term.sessionId);
      if (match) {
        const cwd = match.cwd || '';
        this.wm.setTitle(winId, `${newName} — ${cwd}`);
        break;
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

  updateTaskbar() {
    const container = document.getElementById('taskbar-items'); container.innerHTML = '';
    for (const [id, win] of this.wm.windows) {
      const item = document.createElement('div'); item.className = 'taskbar-item';
      if (id === this.wm.activeWindowId && !win.isMinimized) item.classList.add('active');
      if (win.isMinimized) item.classList.add('minimized');
      if (win.element.classList.contains('window-waiting')) item.classList.add('waiting');
      if (win.type === 'terminal') {
        const term = this.sessions.get(id);
        // Check if this session is starred
        const allSess = this.sidebar?._allSessions || [];
        const match = allSess.find(s => s.webuiId && s.webuiId === term?.sessionId);
        const isStarred = match && this.sidebar.isStarred(match.sessionId);
        if (isStarred) {
          const star = document.createElement('span'); star.textContent = '★'; star.style.cssText = 'color:var(--yellow);font-size:10px;margin-right:2px'; item.appendChild(star);
        } else {
          const dot = document.createElement('span'); dot.className = 'taskbar-dot'; if (win.exited) dot.classList.add('exited'); item.appendChild(dot);
        }
      }
      const label = document.createElement('span'); label.textContent = win.title; item.appendChild(label);
      item.addEventListener('click', () => {
        if (win.isMinimized) this.wm.restore(id);
        else if (id === this.wm.activeWindowId) this.wm.minimize(id);
        else this.wm.focusWindow(id);
        const session = this.sessions.get(id); if (session && !win.isMinimized) session.focus();
      });
      container.appendChild(item);
    }
    const activeCount = [...this.wm.windows.values()].filter(w => w.type==='terminal' && !w.exited).length;
    const countEl = document.getElementById('active-count');
    countEl.textContent = `${activeCount} active`;
    countEl.style.cursor = 'pointer';
    countEl.onclick = (e) => { e.stopPropagation(); this._showWindowList(countEl); };
  }

  _showWindowList(anchor) {
    document.querySelectorAll('.overlap-switcher').forEach(p => p.remove());
    if (!this.wm.windows.size) return;

    const pop = document.createElement('div');
    pop.className = 'overlap-switcher';

    for (const [id, win] of this.wm.windows) {
      const item = document.createElement('div');
      item.className = 'overlap-switcher-item';
      if (id === this.wm.activeWindowId && !win.isMinimized) item.classList.add('active');

      // Check if starred
      const term = this.sessions.get(id);
      const allSess = this.sidebar?._allSessions || [];
      const match = allSess.find(s => s.webuiId && s.webuiId === term?.sessionId);
      const isStarred = match && this.sidebar.isStarred(match.sessionId);

      const indicator = document.createElement('span');
      if (isStarred) {
        indicator.textContent = '★'; indicator.style.cssText = 'color:var(--yellow);font-size:11px;flex-shrink:0';
      } else {
        indicator.className = 'taskbar-dot';
        if (win.exited) indicator.classList.add('exited');
      }
      if (win.isMinimized) indicator.style.opacity = '0.4';
      const label = document.createElement('span');
      label.textContent = (win.isMinimized ? '⊞ ' : '') + win.title;
      item.append(indicator, label);
      item.onclick = () => {
        if (win.isMinimized) this.wm.restore(id);
        else this.wm.focusWindow(id);
        const session = this.sessions.get(id);
        if (session) session.focus();
        pop.remove();
      };
      pop.appendChild(item);
    }

    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    requestAnimationFrame(() => {
      pop.style.left = Math.max(0, rect.right - pop.offsetWidth) + 'px';
      pop.style.top = (rect.top - pop.offsetHeight - 4) + 'px';
    });

    attachPopoverClose(pop, anchor);
  }
}

export { App };
