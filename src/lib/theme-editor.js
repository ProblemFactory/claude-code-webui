import { THEMES, BUILTIN_THEMES } from './themes.js';

// All CSS custom properties that themes define
const CSS_VAR_DEFS = [
  // Backgrounds
  { key: '--bg-root', label: 'Root', group: 'Backgrounds' },
  { key: '--bg-workspace', label: 'Workspace', group: 'Backgrounds' },
  { key: '--bg-window', label: 'Window', group: 'Backgrounds' },
  { key: '--bg-titlebar', label: 'Title Bar', group: 'Backgrounds' },
  { key: '--bg-titlebar-active', label: 'Title Bar (active)', group: 'Backgrounds' },
  { key: '--bg-toolbar', label: 'Toolbar', group: 'Backgrounds' },
  { key: '--bg-taskbar', label: 'Taskbar', group: 'Backgrounds' },
  { key: '--bg-input', label: 'Input', group: 'Backgrounds' },
  { key: '--bg-dialog', label: 'Dialog', group: 'Backgrounds' },
  { key: '--bg-sidebar', label: 'Sidebar', group: 'Backgrounds' },
  // Text
  { key: '--text', label: 'Primary', group: 'Text' },
  { key: '--text-secondary', label: 'Secondary', group: 'Text' },
  { key: '--text-dim', label: 'Dim', group: 'Text' },
  // Accent
  { key: '--accent', label: 'Accent', group: 'Accent' },
  { key: '--accent-hover', label: 'Accent Hover', group: 'Accent' },
  { key: '--accent-dim', label: 'Accent Dim', group: 'Accent', isRgba: true },
  // Status
  { key: '--green', label: 'Green', group: 'Status' },
  { key: '--red', label: 'Red', group: 'Status' },
  { key: '--yellow', label: 'Yellow', group: 'Status' },
  { key: '--blue', label: 'Blue', group: 'Status' },
  // Borders
  { key: '--border', label: 'Border', group: 'Borders', isRgba: true },
  { key: '--border-active', label: 'Border Active', group: 'Borders', isRgba: true },
  { key: '--bg-hover', label: 'Hover', group: 'Borders', isRgba: true },
  // Terminal
  { key: '--terminal-bg', label: 'Terminal BG', group: 'Terminal CSS' },
  { key: '--terminal-fg', label: 'Terminal FG', group: 'Terminal CSS' },
  { key: '--terminal-cursor', label: 'Terminal Cursor', group: 'Terminal CSS' },
  // Effects
  { key: '--shadow-window', label: 'Window Shadow', group: 'Effects', isText: true },
  { key: '--shadow-active', label: 'Active Shadow', group: 'Effects', isText: true },
  // Dimensions
  { key: '--radius', label: 'Border Radius', group: 'Dimensions', isText: true },
  { key: '--radius-sm', label: 'Border Radius (sm)', group: 'Dimensions', isText: true },
];

const TERMINAL_COLOR_DEFS = [
  { key: 'background', label: 'Background', group: 'Base' },
  { key: 'foreground', label: 'Foreground', group: 'Base' },
  { key: 'cursor', label: 'Cursor', group: 'Base' },
  { key: 'cursorAccent', label: 'Cursor Accent', group: 'Base' },
  { key: 'selectionBackground', label: 'Selection', group: 'Base', isRgba: true },
  // Normal
  { key: 'black', label: 'Black', group: 'Normal' },
  { key: 'red', label: 'Red', group: 'Normal' },
  { key: 'green', label: 'Green', group: 'Normal' },
  { key: 'yellow', label: 'Yellow', group: 'Normal' },
  { key: 'blue', label: 'Blue', group: 'Normal' },
  { key: 'magenta', label: 'Magenta', group: 'Normal' },
  { key: 'cyan', label: 'Cyan', group: 'Normal' },
  { key: 'white', label: 'White', group: 'Normal' },
  // Bright
  { key: 'brightBlack', label: 'Bright Black', group: 'Bright' },
  { key: 'brightRed', label: 'Bright Red', group: 'Bright' },
  { key: 'brightGreen', label: 'Bright Green', group: 'Bright' },
  { key: 'brightYellow', label: 'Bright Yellow', group: 'Bright' },
  { key: 'brightBlue', label: 'Bright Blue', group: 'Bright' },
  { key: 'brightMagenta', label: 'Bright Magenta', group: 'Bright' },
  { key: 'brightCyan', label: 'Bright Cyan', group: 'Bright' },
  { key: 'brightWhite', label: 'Bright White', group: 'Bright' },
];

const CSS_VAR_GROUPS = [...new Set(CSS_VAR_DEFS.map(d => d.group))];
const TERM_COLOR_GROUPS = [...new Set(TERMINAL_COLOR_DEFS.map(d => d.group))];

class ThemeEditor {
  constructor(app) {
    this.app = app;
    this._cssValues = {};
    this._termValues = {};
    this._customThemes = {};
    this._previewActive = false;
    this._originalTheme = null;
  }

  open(startFrom) {
    this._originalTheme = this.app.themeManager.current;
    this._loadCustomThemes().then(() => this._showDialog(startFrom));
  }

  async _loadCustomThemes() {
    try {
      const res = await fetch('/api/custom-themes');
      if (!res.ok) throw new Error();
      this._customThemes = await res.json();
    } catch { this._customThemes = {}; }
  }

  _populateFromTheme(themeName) {
    // CSS vars
    const varNames = CSS_VAR_DEFS.map(d => d.key);
    // For custom themes, read from saved data
    if (themeName.startsWith('custom-')) {
      const name = themeName.slice(7);
      const saved = this._customThemes[name];
      if (saved) {
        this._cssValues = { ...saved.css };
        this._termValues = { ...saved.terminal };
        return;
      }
    }
    this._cssValues = this.app.themeManager.extractThemeValues(themeName, varNames);
    // Terminal colors from THEMES
    const term = THEMES[themeName]?.terminal || THEMES.dark.terminal;
    this._termValues = { ...term };
  }

  _showDialog(startFrom) {
    // Remove existing panel
    document.querySelectorAll('.theme-editor-panel').forEach(el => el.remove());
    this._panel = null;

    const baseTheme = startFrom || this._originalTheme;
    this._populateFromTheme(baseTheme);

    const panel = document.createElement('div');
    panel.className = 'theme-editor-panel';
    this._panel = panel;

    // Header (draggable)
    const header = document.createElement('div');
    header.className = 'theme-editor-header';
    const title = document.createElement('h3');
    title.textContent = 'Theme Editor';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'dialog-close';
    closeBtn.textContent = '\u2715';
    closeBtn.onclick = () => this._close();
    header.append(title, closeBtn);

    // Make header draggable
    this._setupDrag(header, panel);

    // Controls bar
    const controls = document.createElement('div');
    controls.className = 'theme-editor-controls';

    // "Start from" selector
    const fromLabel = document.createElement('label');
    fromLabel.textContent = 'Base:';
    const fromSel = document.createElement('select');
    fromSel.className = 'theme-editor-select';
    for (const name of BUILTIN_THEMES) {
      const o = document.createElement('option');
      o.value = name; o.textContent = name.charAt(0).toUpperCase() + name.slice(1);
      fromSel.appendChild(o);
    }
    const customNames = Object.keys(this._customThemes);
    if (customNames.length) {
      const sep = document.createElement('option');
      sep.disabled = true; sep.textContent = '\u2500\u2500 Custom \u2500\u2500';
      fromSel.appendChild(sep);
      for (const name of customNames) {
        const o = document.createElement('option');
        o.value = 'custom-' + name; o.textContent = name;
        fromSel.appendChild(o);
      }
    }
    fromSel.value = baseTheme;
    fromSel.onchange = () => {
      this._populateFromTheme(fromSel.value);
      this._renderBody(body);
      this._applyLivePreview();
    };

    // Theme name input
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name:';
    const nameInput = document.createElement('input');
    nameInput.className = 'theme-editor-name';
    nameInput.placeholder = 'My Theme';
    if (baseTheme.startsWith('custom-')) {
      nameInput.value = baseTheme.slice(7);
    }

    // Save button
    const saveBtn = document.createElement('button');
    saveBtn.className = 'theme-editor-save';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = () => this._save(nameInput.value.trim());

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'theme-editor-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.onclick = () => this._delete(fromSel, nameInput);

    controls.append(fromLabel, fromSel, nameLabel, nameInput, saveBtn, deleteBtn);

    // Preview (fixed, not scrollable)
    const preview = document.createElement('div');
    preview.className = 'theme-editor-preview';
    preview.appendChild(this._buildPreviewCard());
    this._previewEl = preview;

    // Body (scrollable)
    const body = document.createElement('div');
    body.className = 'theme-editor-body';
    this._renderBody(body);

    // Resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'theme-editor-resize';
    this._setupResize(resizeHandle, panel);

    panel.append(header, controls, preview, body, resizeHandle);
    document.body.appendChild(panel);

    // Start live preview
    this._applyLivePreview();
  }

  _setupDrag(handle, panel) {
    let startX, startY, startLeft, startTop;
    const onMove = (e) => {
      panel.style.left = (startLeft + e.clientX - startX) + 'px';
      panel.style.top = (startTop + e.clientY - startY) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      // Switch from right-positioned to left-positioned on first drag
      panel.style.right = 'auto';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  _setupResize(handle, panel) {
    let startX, startY, startW, startH;
    const onMove = (e) => {
      const w = Math.max(320, startW + e.clientX - startX);
      const h = Math.max(300, startH + e.clientY - startY);
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX; startY = e.clientY;
      startW = panel.offsetWidth; startH = panel.offsetHeight;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  _renderBody(body) {
    body.innerHTML = '';

    // CSS Variables section
    const cssSection = document.createElement('div');
    cssSection.className = 'theme-editor-section';
    const cssSectionTitle = document.createElement('h4');
    cssSectionTitle.textContent = 'UI Colors';
    cssSectionTitle.className = 'theme-editor-section-title';
    cssSection.appendChild(cssSectionTitle);

    for (const group of CSS_VAR_GROUPS) {
      const groupEl = this._buildGroup(group,
        CSS_VAR_DEFS.filter(d => d.group === group),
        this._cssValues, 'css');
      cssSection.appendChild(groupEl);
    }
    body.appendChild(cssSection);

    // Terminal Colors section
    const termSection = document.createElement('div');
    termSection.className = 'theme-editor-section';
    const termTitle = document.createElement('h4');
    termTitle.textContent = 'Terminal ANSI Colors';
    termTitle.className = 'theme-editor-section-title';
    termSection.appendChild(termTitle);

    for (const group of TERM_COLOR_GROUPS) {
      const groupEl = this._buildGroup(group,
        TERMINAL_COLOR_DEFS.filter(d => d.group === group),
        this._termValues, 'terminal');
      termSection.appendChild(groupEl);
    }
    body.appendChild(termSection);
  }

  _buildPreviewCard() {
    const card = document.createElement('div');
    card.className = 'theme-preview-card';
    card.innerHTML = `
      <div class="tp-row">
        <div class="tp-bg" style="background:var(--bg-root)" title="--bg-root">
          <div class="tp-bg" style="background:var(--bg-sidebar);flex:0 0 60px;padding:6px" title="--bg-sidebar">
            <div style="font-size:9px;color:var(--text-dim)">Sidebar</div>
            <div style="font-size:10px;color:var(--text);margin-top:3px">Session</div>
            <div style="font-size:9px;color:var(--text-secondary);margin-top:1px">~/project</div>
          </div>
          <div style="flex:1;display:flex;flex-direction:column;gap:4px;padding:4px">
            <div class="tp-bg" style="background:var(--bg-toolbar);padding:4px 8px;border-radius:var(--radius-sm)" title="--bg-toolbar">
              <span style="font-size:9px;color:var(--text-dim)">Toolbar</span>
              <span style="font-size:9px;color:var(--accent);margin-left:8px;cursor:default" title="--accent">Accent</span>
              <span style="font-size:9px;color:var(--accent-hover);margin-left:4px" title="--accent-hover">Hover</span>
            </div>
            <div style="flex:1;display:flex;gap:4px">
              <div class="tp-bg" style="background:var(--bg-window);flex:1;border:1px solid var(--border);border-radius:var(--radius-sm);display:flex;flex-direction:column" title="--bg-window">
                <div style="background:var(--bg-titlebar);padding:3px 6px;border-radius:var(--radius-sm) var(--radius-sm) 0 0;font-size:9px;color:var(--text-dim);display:flex;justify-content:space-between" title="--bg-titlebar">
                  <span>Window</span><span style="color:var(--green)" title="--green">LIVE</span>
                </div>
                <div style="background:var(--bg-titlebar-active);padding:3px 6px;font-size:9px;color:var(--text);border-bottom:1px solid var(--border-active)" title="--bg-titlebar-active + --border-active">Active Title</div>
                <div style="flex:1;padding:6px;font-size:9px">
                  <span style="color:var(--text)" title="--text">Primary text</span><br>
                  <span style="color:var(--text-secondary)" title="--text-secondary">Secondary text</span><br>
                  <span style="color:var(--text-dim)" title="--text-dim">Dim text</span>
                </div>
              </div>
              <div style="flex:1;display:flex;flex-direction:column;gap:4px">
                <div class="tp-bg" style="background:var(--bg-dialog);flex:1;border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px" title="--bg-dialog">
                  <div style="font-size:9px;color:var(--text)">Dialog</div>
                  <input style="margin-top:3px;width:calc(100% - 12px);background:var(--bg-input);border:1px solid var(--border);color:var(--text);padding:2px 4px;border-radius:var(--radius-sm);font-size:9px" value="Input field" readonly title="--bg-input">
                  <div style="margin-top:4px;display:flex;gap:3px;flex-wrap:wrap">
                    <span class="tp-badge" style="background:var(--green);color:#fff" title="--green">Live</span>
                    <span class="tp-badge" style="background:var(--red);color:#fff" title="--red">Error</span>
                    <span class="tp-badge" style="background:var(--yellow);color:#000" title="--yellow">Warn</span>
                    <span class="tp-badge" style="background:var(--blue);color:#fff" title="--blue">Info</span>
                  </div>
                  <div style="margin-top:4px;padding:3px 6px;background:var(--bg-hover);border-radius:var(--radius-sm);font-size:9px;color:var(--text-secondary)" title="--bg-hover">Hover state</div>
                </div>
              </div>
            </div>
            <div class="tp-bg" style="background:var(--bg-taskbar);padding:3px 8px;border-radius:var(--radius-sm);font-size:9px;color:var(--text-dim)" title="--bg-taskbar">Taskbar</div>
          </div>
        </div>
      </div>
      <div class="tp-row" style="margin-top:6px">
        <div class="tp-terminal" style="background:var(--terminal-bg);border-radius:var(--radius-sm);padding:6px;font-family:'SF Mono','Fira Code',monospace;font-size:10px;line-height:1.5" title="Terminal">
          <span style="color:var(--terminal-fg)" title="--terminal-fg">$ </span><span style="color:var(--terminal-cursor);text-decoration:underline" title="--terminal-cursor">_</span><br>
          <span style="color:var(--terminal-fg)">Normal </span>
          <span class="tp-ansi" style="color:var(--t-black,#000)" data-c="black">Blk</span>
          <span class="tp-ansi" style="color:var(--t-red,red)" data-c="red">Red</span>
          <span class="tp-ansi" style="color:var(--t-green,green)" data-c="green">Grn</span>
          <span class="tp-ansi" style="color:var(--t-yellow,yellow)" data-c="yellow">Yel</span>
          <span class="tp-ansi" style="color:var(--t-blue,blue)" data-c="blue">Blu</span>
          <span class="tp-ansi" style="color:var(--t-magenta,magenta)" data-c="magenta">Mag</span>
          <span class="tp-ansi" style="color:var(--t-cyan,cyan)" data-c="cyan">Cyn</span>
          <span class="tp-ansi" style="color:var(--t-white,white)" data-c="white">Wht</span><br>
          <span style="color:var(--terminal-fg)">Bright </span>
          <span class="tp-ansi" data-c="brightBlack">Blk</span>
          <span class="tp-ansi" data-c="brightRed">Red</span>
          <span class="tp-ansi" data-c="brightGreen">Grn</span>
          <span class="tp-ansi" data-c="brightYellow">Yel</span>
          <span class="tp-ansi" data-c="brightBlue">Blu</span>
          <span class="tp-ansi" data-c="brightMagenta">Mag</span>
          <span class="tp-ansi" data-c="brightCyan">Cyn</span>
          <span class="tp-ansi" data-c="brightWhite">Wht</span>
        </div>
      </div>`;

    // Apply terminal ANSI colors to preview spans
    this._updatePreviewTermColors(card);
    return card;
  }

  _updatePreviewTermColors(card) {
    if (!card) card = this._previewEl?.querySelector('.theme-preview-card');
    if (!card) return;
    const spans = card.querySelectorAll('.tp-ansi[data-c]');
    for (const span of spans) {
      const key = span.dataset.c;
      if (this._termValues[key]) span.style.color = this._termValues[key];
    }
  }

  _buildGroup(groupName, defs, values, type) {
    const wrapper = document.createElement('div');
    wrapper.className = 'theme-editor-group';

    const label = document.createElement('div');
    label.className = 'theme-editor-group-label';
    label.textContent = groupName;
    wrapper.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'theme-editor-grid';

    for (const def of defs) {
      const row = document.createElement('div');
      row.className = 'theme-editor-row';

      const lbl = document.createElement('span');
      lbl.className = 'theme-editor-label';
      lbl.textContent = def.label;

      const val = values[def.key] || '';

      if (def.isText) {
        // Text-only input (shadows, dimensions)
        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'theme-editor-text';
        textInput.value = val;
        textInput.oninput = () => {
          values[def.key] = textInput.value;
          this._applyLivePreview();
        };
        row.append(lbl, textInput);
      } else if (def.isRgba) {
        // rgba value: color picker (for hex part) + text input
        const hexVal = this._rgbaToHex(val);
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'theme-editor-color';
        colorInput.value = hexVal;

        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'theme-editor-hex';
        textInput.value = val;

        colorInput.oninput = () => {
          // When user picks color from picker, keep original alpha if rgba
          const alpha = this._extractAlpha(values[def.key]);
          const hex = colorInput.value;
          const r = parseInt(hex.slice(1, 3), 16);
          const g = parseInt(hex.slice(3, 5), 16);
          const b = parseInt(hex.slice(5, 7), 16);
          const newVal = alpha < 1 ? `rgba(${r},${g},${b},${alpha})` : hex;
          values[def.key] = newVal;
          textInput.value = newVal;
          this._applyLivePreview();
        };
        textInput.oninput = () => {
          values[def.key] = textInput.value;
          const hex = this._rgbaToHex(textInput.value);
          if (hex !== '#000000' || textInput.value.includes('0,0,0')) colorInput.value = hex;
          this._applyLivePreview();
        };
        row.append(lbl, colorInput, textInput);
      } else {
        // Standard hex color
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'theme-editor-color';
        colorInput.value = this._normalizeHex(val);

        const hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.className = 'theme-editor-hex';
        hexInput.value = val;

        colorInput.oninput = () => {
          values[def.key] = colorInput.value;
          hexInput.value = colorInput.value;
          this._applyLivePreview();
        };
        hexInput.oninput = () => {
          values[def.key] = hexInput.value;
          const n = this._normalizeHex(hexInput.value);
          if (/^#[0-9a-f]{6}$/i.test(n)) colorInput.value = n;
          this._applyLivePreview();
        };
        row.append(lbl, colorInput, hexInput);
      }

      // Hover-to-highlight: flash the variable so user sees what it affects
      if (type === 'css' && !def.isText) {
        row.addEventListener('mouseenter', () => this._startHighlight(def.key, values[def.key]));
        row.addEventListener('mouseleave', () => this._stopHighlight(def.key, values[def.key]));
      } else if (type === 'terminal' && !def.isText) {
        row.addEventListener('mouseenter', () => this._startTermHighlight(def.key, values[def.key]));
        row.addEventListener('mouseleave', () => this._stopTermHighlight(def.key, values[def.key]));
      }

      grid.appendChild(row);
    }
    wrapper.appendChild(grid);
    return wrapper;
  }

  _applyLivePreview() {
    this._previewActive = true;
    // CSS variables
    this.app.themeManager.setLivePreview(this._cssValues);
    // Terminal colors
    for (const [, session] of this.app.sessions) {
      if (session.updateTheme) session.updateTheme(this._termValues);
    }
    // Update preview card terminal colors
    this._updatePreviewTermColors();
  }

  _revertPreview() {
    if (!this._previewActive) return;
    this._previewActive = false;
    this.app.themeManager._clearInlineOverrides();
    // Restore original theme's terminal colors
    this.app.themeManager.apply(this.app.themeManager.current);
    const termTheme = this.app.themeManager.getTerminalTheme();
    for (const [, session] of this.app.sessions) {
      if (session.updateTheme) session.updateTheme(termTheme);
    }
  }

  async _save(name) {
    if (!name) { alert('Please enter a theme name.'); return; }
    if (!/^[a-zA-Z0-9 _-]+$/.test(name)) { alert('Name must be alphanumeric (spaces, hyphens, underscores allowed).'); return; }
    if (name.length > 50) { alert('Name too long (max 50 characters).'); return; }
    const builtIn = ['dark', 'light', 'dracula', 'nord', 'solarized', 'monokai'];
    if (builtIn.includes(name.toLowerCase())) { alert('Cannot use a built-in theme name.'); return; }

    try {
      const res = await fetch('/api/custom-themes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, css: this._cssValues, terminal: this._termValues }),
      });
      if (!res.ok) { const e = await res.json(); alert(e.error); return; }
    } catch (e) { alert('Save failed: ' + e.message); return; }

    // Register locally
    this.app.themeManager.registerCustomTheme(name, this._cssValues, this._termValues);
    this._previewActive = false;
    this.app.themeManager.apply('custom-' + name);
    const termTheme = this.app.themeManager.getTerminalTheme();
    for (const [, session] of this.app.sessions) {
      if (session.updateTheme) session.updateTheme(termTheme);
    }
    if (this.app._refreshThemeDropdown) this.app._refreshThemeDropdown();
    this._close();
  }

  async _delete(fromSel, nameInput) {
    const current = fromSel.value;
    if (!current.startsWith('custom-')) { alert('Can only delete custom themes.'); return; }
    const name = current.slice(7);
    if (!confirm(`Delete custom theme "${name}"?`)) return;

    try {
      const res = await fetch('/api/custom-themes/' + encodeURIComponent(name), { method: 'DELETE' });
      if (!res.ok) { const e = await res.json(); alert(e.error); return; }
    } catch (e) { alert('Delete failed: ' + e.message); return; }

    this.app.themeManager.unregisterCustomTheme(name);
    delete this._customThemes[name];
    if (this.app._refreshThemeDropdown) this.app._refreshThemeDropdown();
    this._previewActive = false;
    this.app.themeManager.apply('dark');
    const termTheme = this.app.themeManager.getTerminalTheme();
    for (const [, session] of this.app.sessions) {
      if (session.updateTheme) session.updateTheme(termTheme);
    }
    // Refresh editor state
    fromSel.value = 'dark';
    nameInput.value = '';
    this._populateFromTheme('dark');
    const body = this._panel?.querySelector('.theme-editor-body');
    if (body) this._renderBody(body);
    this._applyLivePreview();
  }

  _close() {
    this._stopHighlightTimer();
    this._revertPreview();
    if (this._panel) { this._panel.remove(); this._panel = null; }
  }

  // ── Hover-to-highlight: pulse a CSS variable between its value and a highlight color ──

  _startHighlight(varKey, originalVal) {
    this._stopHighlightTimer();
    const root = document.documentElement;
    const highlight = this._contrastHighlight(originalVal);
    let on = true;
    // Immediate first flash
    root.style.setProperty(varKey, highlight);
    this._highlightTimer = setInterval(() => {
      on = !on;
      root.style.setProperty(varKey, on ? highlight : originalVal);
    }, 400);
    this._highlightKey = varKey;
    this._highlightOriginal = originalVal;
  }

  _stopHighlight(varKey, originalVal) {
    this._stopHighlightTimer();
    // Restore the current edited value
    document.documentElement.style.setProperty(varKey, originalVal);
  }

  _startTermHighlight(termKey, originalVal) {
    this._stopHighlightTimer();
    const highlight = this._contrastHighlight(originalVal);
    let on = true;
    const apply = (val) => {
      const theme = { ...this._termValues, [termKey]: val };
      for (const [, session] of this.app.sessions) {
        if (session.updateTheme) session.updateTheme(theme);
      }
    };
    apply(highlight);
    this._highlightTimer = setInterval(() => {
      on = !on;
      apply(on ? highlight : originalVal);
    }, 400);
    this._highlightKey = termKey;
    this._highlightOriginal = originalVal;
  }

  _stopTermHighlight(termKey, originalVal) {
    this._stopHighlightTimer();
    // Restore full terminal theme
    for (const [, session] of this.app.sessions) {
      if (session.updateTheme) session.updateTheme(this._termValues);
    }
  }

  _stopHighlightTimer() {
    if (this._highlightTimer) {
      clearInterval(this._highlightTimer);
      this._highlightTimer = null;
    }
  }

  // Pick a highlight color that contrasts with the original
  _contrastHighlight(val) {
    const hex = this._normalizeHex(val);
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // Luminance check: if dark, flash bright magenta; if light, flash dark magenta
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.5 ? '#ff00ff' : '#ff66ff';
  }

  // ── Color conversion helpers ──

  _normalizeHex(val) {
    if (!val) return '#000000';
    val = val.trim();
    if (/^#[0-9a-f]{6}$/i.test(val)) return val;
    if (/^#[0-9a-f]{3}$/i.test(val)) {
      return '#' + val[1] + val[1] + val[2] + val[2] + val[3] + val[3];
    }
    // Try parsing rgb/rgba
    const m = val.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
      const hex = (n) => parseInt(n).toString(16).padStart(2, '0');
      return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
    }
    return '#000000';
  }

  _rgbaToHex(val) {
    return this._normalizeHex(val);
  }

  _extractAlpha(val) {
    if (!val) return 1;
    const m = val.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/);
    return m ? parseFloat(m[1]) : 1;
  }
}

export { ThemeEditor };
