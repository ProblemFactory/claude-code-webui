import { SETTINGS_SCHEMA, SETTINGS_CATEGORIES } from './settings-schema.js';

/**
 * SettingsUI — VS Code-style settings page.
 * Left: category nav. Right: searchable setting controls. Schema-driven.
 */
class SettingsUI {
  constructor(app) {
    this.app = app;
    this.settings = app.settings;
    this._search = '';
  }

  open() {
    this._showDialog();
  }

  _showDialog() {
    // Remove any existing settings dialog
    document.querySelectorAll('.settings-overlay').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });

    const dialog = document.createElement('div');
    dialog.className = 'settings-dialog';

    // Header
    const header = document.createElement('div');
    header.className = 'settings-header';
    const title = document.createElement('h3');
    title.textContent = 'Settings';
    const headerRight = document.createElement('div');
    headerRight.className = 'settings-header-actions';
    const resetAllBtn = document.createElement('button');
    resetAllBtn.className = 'settings-header-btn';
    resetAllBtn.textContent = 'Reset All';
    resetAllBtn.title = 'Reset all settings to defaults';
    resetAllBtn.onclick = () => { if (confirm('Reset all settings to defaults?')) { this.settings.resetAll(); this._renderContent(content, nav); } };
    const closeBtn = document.createElement('button');
    closeBtn.className = 'dialog-close';
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => overlay.remove();
    headerRight.append(resetAllBtn, closeBtn);
    header.append(title, headerRight);

    // Search
    const searchWrap = document.createElement('div');
    searchWrap.className = 'settings-search-wrap';
    const searchInput = document.createElement('input');
    searchInput.className = 'settings-search';
    searchInput.placeholder = 'Search settings...';
    this._search = ''; // clear filter on open
    searchInput.oninput = () => { this._search = searchInput.value.toLowerCase(); this._renderContent(content, nav); };
    searchWrap.appendChild(searchInput);

    // Body: nav + content
    const body = document.createElement('div');
    body.className = 'settings-body';
    const nav = document.createElement('nav');
    nav.className = 'settings-nav';
    const content = document.createElement('div');
    content.className = 'settings-content';
    body.append(nav, content);

    dialog.append(header, searchWrap, body);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    this._renderContent(content, nav);
    searchInput.focus();
  }

  _renderContent(content, nav) {
    content.innerHTML = '';
    nav.innerHTML = '';

    const query = this._search;

    // Group settings by category
    const grouped = {};
    for (const cat of SETTINGS_CATEGORIES) grouped[cat] = [];
    for (const [path, schema] of Object.entries(SETTINGS_SCHEMA)) {
      if (query) {
        const haystack = (schema.label + ' ' + schema.description + ' ' + path).toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      const cat = schema.category || 'Other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push({ path, schema });
    }

    for (const cat of SETTINGS_CATEGORIES) {
      const items = grouped[cat];
      if (!items || !items.length) continue;

      // Nav item
      const navItem = document.createElement('div');
      navItem.className = 'settings-nav-item';
      navItem.textContent = cat;
      navItem.onclick = () => {
        const section = content.querySelector(`[data-category="${cat}"]`);
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      nav.appendChild(navItem);

      // Section
      const section = document.createElement('div');
      section.className = 'settings-section';
      section.dataset.category = cat;
      const sectionTitle = document.createElement('div');
      sectionTitle.className = 'settings-section-title';
      sectionTitle.textContent = cat;
      section.appendChild(sectionTitle);

      for (const { path, schema } of items) {
        section.appendChild(this._renderSetting(path, schema));
      }

      content.appendChild(section);
    }

    if (!content.children.length) {
      content.innerHTML = '<div class="settings-empty">No settings match your search.</div>';
    }
  }

  _renderSetting(path, schema) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    if (this.settings.isModified(path)) row.classList.add('modified');

    const info = document.createElement('div');
    info.className = 'settings-row-info';
    const label = document.createElement('div');
    label.className = 'settings-row-label';
    label.textContent = schema.label;
    if (!schema.liveApply) {
      const badge = document.createElement('span');
      badge.className = 'settings-reload-badge';
      badge.textContent = 'reload';
      badge.title = 'Requires page reload to take effect';
      label.appendChild(badge);
    }
    const desc = document.createElement('div');
    desc.className = 'settings-row-desc';
    desc.textContent = schema.description;
    const pathEl = document.createElement('div');
    pathEl.className = 'settings-row-path';
    pathEl.textContent = path;
    info.append(label, desc, pathEl);

    const controlWrap = document.createElement('div');
    controlWrap.className = 'settings-row-control';

    const control = this._createControl(path, schema, row);
    controlWrap.appendChild(control);

    // Reset button (only shown when modified)
    if (this.settings.isModified(path)) {
      const resetBtn = document.createElement('button');
      resetBtn.className = 'settings-reset-btn';
      resetBtn.textContent = '↺';
      resetBtn.title = 'Reset to default';
      resetBtn.onclick = () => { this.settings.reset(path); row.classList.remove('modified'); this._refreshControl(row, path, schema); };
      controlWrap.appendChild(resetBtn);
    }

    row.append(info, controlWrap);
    return row;
  }

  _createControl(path, schema, row) {
    const value = this.settings.get(path);

    if (schema.type === 'boolean') {
      const toggle = document.createElement('label');
      toggle.className = 'settings-toggle';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value;
      input.onchange = () => { this.settings.set(path, input.checked); row.classList.toggle('modified', this.settings.isModified(path)); };
      const slider = document.createElement('span');
      slider.className = 'settings-toggle-slider';
      toggle.append(input, slider);
      return toggle;
    }

    if (schema.type === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'settings-input-number';
      input.value = value;
      if (schema.min !== undefined) input.min = schema.min;
      if (schema.max !== undefined) input.max = schema.max;
      if (schema.step !== undefined) input.step = schema.step;
      input.onchange = () => { this.settings.set(path, parseFloat(input.value)); row.classList.toggle('modified', this.settings.isModified(path)); };
      return input;
    }

    if (schema.type === 'enum') {
      // Combobox mode: dropdown + custom text input for types that allow free-form values
      if (schema.combobox) {
        const wrap = document.createElement('div');
        wrap.className = 'settings-combobox';
        const select = document.createElement('select');
        select.className = 'settings-select';
        const customOpt = document.createElement('option');
        customOpt.value = '__custom__'; customOpt.textContent = 'Custom...';
        for (const opt of schema.options) {
          const o = document.createElement('option');
          o.value = opt.value; o.textContent = opt.label;
          select.appendChild(o);
        }
        select.appendChild(customOpt);
        const input = document.createElement('input');
        input.type = 'text'; input.className = 'settings-input-text';
        input.placeholder = 'e.g. claude-opus-4-6-20250414';
        // Determine initial state
        const knownValues = schema.options.map(o => o.value);
        const isCustom = value && !knownValues.includes(value);
        if (isCustom) {
          select.value = '__custom__';
          input.value = value;
          input.style.display = '';
        } else {
          select.value = value;
          input.style.display = 'none';
        }
        select.onchange = () => {
          if (select.value === '__custom__') {
            input.style.display = ''; input.focus();
            this.settings.set(path, input.value);
          } else {
            input.style.display = 'none';
            this.settings.set(path, select.value);
          }
          row.classList.toggle('modified', this.settings.isModified(path));
        };
        input.onchange = () => { this.settings.set(path, input.value); row.classList.toggle('modified', this.settings.isModified(path)); };
        wrap.append(select, input);
        return wrap;
      }
      const select = document.createElement('select');
      select.className = 'settings-select';
      for (const opt of schema.options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (String(value) === String(opt.value)) o.selected = true;
        select.appendChild(o);
      }
      select.onchange = () => { this.settings.set(path, select.value); row.classList.toggle('modified', this.settings.isModified(path)); };
      return select;
    }

    if (schema.type === 'multiSelect') {
      const wrap = document.createElement('div');
      wrap.className = 'settings-multi-select';
      const current = Array.isArray(value) ? value : [];
      for (const opt of schema.options) {
        const label = document.createElement('label');
        label.className = 'settings-checkbox-label';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = current.includes(opt.value);
        cb.onchange = () => {
          const updated = [];
          wrap.querySelectorAll('input[type=checkbox]').forEach((c, i) => { if (c.checked) updated.push(schema.options[i].value); });
          this.settings.set(path, updated);
          row.classList.toggle('modified', this.settings.isModified(path));
        };
        const span = document.createElement('span');
        span.textContent = opt.label;
        label.append(cb, span);
        wrap.appendChild(label);
      }
      return wrap;
    }

    if (schema.type === 'json') {
      const textarea = document.createElement('textarea');
      textarea.className = 'settings-json';
      textarea.rows = 4;
      textarea.value = JSON.stringify(value, null, 2);
      textarea.onchange = () => {
        try {
          const parsed = JSON.parse(textarea.value);
          textarea.classList.remove('invalid');
          this.settings.set(path, parsed);
          row.classList.toggle('modified', this.settings.isModified(path));
        } catch {
          textarea.classList.add('invalid');
        }
      };
      return textarea;
    }

    // Fallback: text input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'settings-input-text';
    input.value = String(value);
    input.onchange = () => { this.settings.set(path, input.value); row.classList.toggle('modified', this.settings.isModified(path)); };
    return input;
  }

  _refreshControl(row, path, schema) {
    const controlWrap = row.querySelector('.settings-row-control');
    controlWrap.innerHTML = '';
    controlWrap.appendChild(this._createControl(path, schema, row));
  }
}

export { SettingsUI };
