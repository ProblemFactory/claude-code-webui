import { formatSize, attachPopoverClose, createPopover, showContextMenu, getStateSync } from './utils.js';
import { setupDirAutocomplete } from './autocomplete.js';
import { getFileIcon, hasDedicatedViewer } from './file-types.js';
import { FILE_ICONS, UI_ICONS } from './icons.js';
import { FileViewer } from './file-viewer.js';

const DEFAULT_COLUMNS = { name: true, size: true, modified: true, created: false, type: false };
const ALL_COLUMNS = [
  { key: 'name', label: 'Name', defaultWidth: 250, alwaysOn: true },
  { key: 'size', label: 'Size', defaultWidth: 80 },
  { key: 'modified', label: 'Modified', defaultWidth: 140 },
  { key: 'created', label: 'Created', defaultWidth: 140 },
  { key: 'type', label: 'Type', defaultWidth: 70 },
];

function _loadSettings() {
  try { return JSON.parse(localStorage.getItem('fileExplorerSettings')); } catch { return null; }
}
function _saveSettings(s) { localStorage.setItem('fileExplorerSettings', JSON.stringify(s)); }
function _loadColumns() {
  try { const c = JSON.parse(localStorage.getItem('fileExplorerColumns')); return c || { ...DEFAULT_COLUMNS }; } catch { return { ...DEFAULT_COLUMNS }; }
}
function _saveColumns(c) { localStorage.setItem('fileExplorerColumns', JSON.stringify(c)); }

class FileExplorer {
  constructor(winInfo, app, startPath) {
    this.winInfo = winInfo; this.app = app; this.currentPath = ''; this.items = [];
    this._startPath = startPath || null;
    this._viewMode = 'list'; // 'list' or 'icon'
    this._renderLimit = 100; // initial batch size for large folders
    this._bookmarks = [];
    this._selectedPath = null;

    // Load settings
    const saved = _loadSettings();
    this._bookmarksPanelVisible = saved?.bookmarksVisible !== false;
    this._previewVisible = saved?.previewVisible || false;
    this._showHidden = saved?.showHidden || false;
    this._mixedSort = saved?.mixedSort || false;
    this._sortBy = saved?.defaultSort || 'name';
    this._sortAsc = saved?.defaultSortAsc !== undefined ? saved.defaultSortAsc : true;

    // Grouping
    this._groupBy = localStorage.getItem('fileExplorerGroupBy') || 'none';
    this._collapsedGroups = new Set();

    // Load column visibility + widths
    this._columns = _loadColumns();
    this._columnWidths = JSON.parse(localStorage.getItem('fileExplorerColumnWidths') || '{}');

    const el = document.createElement('div'); el.className = 'file-explorer';
    this._el = el;

    // Apply initial column CSS custom properties
    this._applyColumnCSSVars();

    // Toolbar
    const toolbar = document.createElement('div'); toolbar.className = 'file-toolbar';
    const btnUp = this._btn('\u2191', 'Go up'); btnUp.onclick = () => this.navigateUp();
    this.pathInput = document.createElement('input'); this.pathInput.className = 'file-path-input';
    this.pathInput.addEventListener('keydown', e => { if (e.key === 'Enter') { if (this._hideAC) this._hideAC(); this.navigate(this.pathInput.value); } });
    this._acDropdown = document.createElement('div'); this._acDropdown.className = 'path-autocomplete hidden';
    this._setupPathAutocomplete();
    const btnRefresh = this._btn('\u21BB', 'Refresh'); btnRefresh.onclick = () => this.refresh();

    // View menu button
    const btnView = this._btn('', 'View options');
    btnView.innerHTML = '<svg style="width:12px;height:12px;vertical-align:-1px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s3-5.5 7-5.5S15 8 15 8s-3 5.5-7 5.5S1 8 1 8z"/><circle cx="8" cy="8" r="2.5"/></svg> \u25BE';
    btnView.style.width = 'auto';
    btnView.style.padding = '2px 6px';
    btnView.style.fontSize = '11px';
    btnView.onclick = () => this._showViewMenu(btnView);

    const btnNewFile = this._btn('+', 'New file'); btnNewFile.onclick = () => this.createFile();
    const btnNewDir = this._btn('', 'New folder'); btnNewDir.innerHTML = FILE_ICONS.folderOpen; btnNewDir.onclick = () => this.createDir();
    const btnUpload = this._btn('\u2B06', 'Upload'); btnUpload.onclick = () => this._triggerUpload(btnUpload);
    btnUpload.style.position = 'relative';
    this._uploadBtn = btnUpload;
    // Ring progress indicator (Chrome-style, shown during active uploads)
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('viewBox', '0 0 20 20');
    ring.classList.add('upload-ring', 'hidden');
    const bgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bgCircle.setAttribute('cx', '10'); bgCircle.setAttribute('cy', '10'); bgCircle.setAttribute('r', '8');
    bgCircle.setAttribute('fill', 'none'); bgCircle.setAttribute('stroke', 'var(--border)'); bgCircle.setAttribute('stroke-width', '2');
    const fgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    fgCircle.setAttribute('cx', '10'); fgCircle.setAttribute('cy', '10'); fgCircle.setAttribute('r', '8');
    fgCircle.setAttribute('fill', 'none'); fgCircle.setAttribute('stroke', 'var(--accent)'); fgCircle.setAttribute('stroke-width', '2');
    fgCircle.setAttribute('stroke-linecap', 'round');
    fgCircle.setAttribute('stroke-dasharray', `${2 * Math.PI * 8}`);
    fgCircle.setAttribute('stroke-dashoffset', `${2 * Math.PI * 8}`);
    fgCircle.setAttribute('transform', 'rotate(-90 10 10)');
    ring.append(bgCircle, fgCircle);
    btnUpload.appendChild(ring);
    this._uploadRing = fgCircle;
    this._uploadRingSvg = ring;
    this._ringCircumference = 2 * Math.PI * 8;

    toolbar.style.position = 'relative';
    toolbar.append(btnUp, this.pathInput, btnRefresh, btnView, btnNewFile, btnNewDir, btnUpload, this._acDropdown);

    // Bookmark panel
    this._bookmarkPanel = document.createElement('div'); this._bookmarkPanel.className = 'file-bookmark-panel';
    this._bookmarkList = document.createElement('div'); this._bookmarkList.className = 'file-bookmark-list';
    const bkHeader = document.createElement('div'); bkHeader.className = 'file-bookmark-header';
    const bkTitle = document.createElement('span'); bkTitle.textContent = 'Bookmarks'; bkTitle.className = 'file-bookmark-title';
    bkHeader.append(bkTitle);
    this._bookmarkPanel.append(bkHeader, this._bookmarkList);

    // Sort header (for list view)
    this.sortHeader = document.createElement('div'); this.sortHeader.className = 'file-sort-header';
    this.sortHeader.addEventListener('contextmenu', (e) => { e.preventDefault(); this._showColumnMenu(e.clientX, e.clientY); });
    this._renderSortHeader();

    // Content area: browse area (bookmarks + file list) + preview panel
    const contentArea = document.createElement('div'); contentArea.className = 'file-content-area';
    this.listEl = document.createElement('div'); this.listEl.className = 'file-list';

    // Main pane wraps sort header + file list (so columns align with bookmarks panel open)
    const mainPane = document.createElement('div');
    mainPane.className = 'file-main-pane';
    mainPane.append(this.sortHeader, this.listEl);

    // Browse area keeps bookmarks + main pane always side-by-side
    const browseArea = document.createElement('div');
    browseArea.className = 'file-browse-area';
    browseArea.append(this._bookmarkPanel, mainPane);

    // Preview panel (shows selected file content)
    this._previewPanel = document.createElement('div');
    this._previewPanel.className = 'file-preview-panel' + (this._previewVisible ? '' : ' hidden');
    this._previewContent = document.createElement('div');
    this._previewContent.className = 'file-preview-content';
    const previewHeader = document.createElement('div');
    previewHeader.className = 'file-preview-header';
    this._previewTitle = document.createElement('span');
    this._previewTitle.className = 'file-preview-title';
    this._previewTitle.textContent = 'No file selected';
    previewHeader.append(this._previewTitle);
    this._previewPanel.append(previewHeader, this._previewContent);

    contentArea.append(browseArea, this._previewPanel);
    this._contentArea = contentArea;
    this._el = el;
    // Apply saved column widths as CSS vars
    for (const [key, w] of Object.entries(this._columnWidths)) {
      el.style.setProperty(`--col-${key}-w`, w + 'px');
    }
    // Auto-detect preview layout direction based on window aspect ratio
    this._previewRO = new ResizeObserver(() => this._updatePreviewLayout());
    this._previewRO.observe(contentArea);

    // Upload inputs (hidden)
    this.uploadInput = document.createElement('input'); this.uploadInput.type = 'file'; this.uploadInput.multiple = true;
    this.uploadInput.style.display = 'none';
    this.uploadInput.onchange = (e) => { this._uploadFiles(e.target.files); e.target.value = ''; };
    this._folderInput = document.createElement('input'); this._folderInput.type = 'file';
    this._folderInput.setAttribute('webkitdirectory', ''); this._folderInput.style.display = 'none';
    this._folderInput.onchange = (e) => { this._uploadFiles(e.target.files, true); e.target.value = ''; };
    this._activeUploads = new Map(); // uploadId → {xhr, files, rows[]}

    el.append(toolbar, contentArea, this.uploadInput, this._folderInput);
    winInfo.content.appendChild(el);

    // Drag and drop (upload)
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
    el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files.length) this._uploadFiles(e.dataTransfer.files); });

    this.listEl.addEventListener('contextmenu', (e) => {
      e.preventDefault(); const item = e.target.closest('.file-item');
      if (item) this._showContextMenu(e.clientX, e.clientY, item.dataset);
    });

    // Load bookmarks from server
    this._loadBookmarks();

    // Listen for bookmark sync from other clients/windows
    this.app.ws.onGlobal((msg) => {
      if (msg.type === 'bookmarks-updated') {
        this._bookmarks = msg.bookmarks;
        this._renderBookmarks();
      }
    });

    if (this._startPath) this.navigate(this._startPath);
    else this._loadHome();
  }

  _btn(text, title) { const b = document.createElement('button'); b.className = 'file-tool-btn'; b.textContent = text; b.title = title; return b; }

  // ── Column CSS custom properties ──
  _applyColumnCSSVars() {
    for (const col of ALL_COLUMNS) {
      if (col.alwaysOn) continue; // name column uses flex
      const w = this._columnWidths[col.key] || col.defaultWidth;
      this._el.style.setProperty(`--col-${col.key}-w`, w + 'px');
    }
  }

  _saveColumnWidths() {
    localStorage.setItem('fileExplorerColumnWidths', JSON.stringify(this._columnWidths));
  }

  // ── Bookmarks ──
  async _loadBookmarks() {
    try {
      const r = await fetch('/api/bookmarks'); this._bookmarks = await r.json();
    } catch { this._bookmarks = []; }
    this._renderBookmarks();
  }

  async _saveBookmarks() {
    try { await fetch('/api/bookmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this._bookmarks) }); } catch {}
  }

  _renderBookmarks() {
    this._bookmarkList.innerHTML = '';
    // Shared drop handler: determines insert position from mouse Y
    const getInsertIdx = (e) => {
      const items = this._bookmarkList.querySelectorAll('.file-bookmark-item');
      for (let j = 0; j < items.length; j++) {
        const r = items[j].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) return j;
      }
      return this._bookmarks.length;
    };
    // Clear all insertion indicators
    const clearIndicators = () => {
      this._bookmarkList.querySelectorAll('.file-bookmark-item').forEach(el => {
        el.classList.remove('insert-above', 'insert-below');
      });
    };

    this._bookmarks.forEach((bk, i) => {
      const item = document.createElement('div'); item.className = 'file-bookmark-item';
      item.title = bk.path;
      item.textContent = bk.label;
      item.onclick = () => this.navigate(bk.path);
      // Drag to reorder
      item.draggable = true;
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/x-bookmark-idx', String(i));
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        clearIndicators();
        const r = item.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) item.classList.add('insert-above');
        else item.classList.add('insert-below');
      });
      item.addEventListener('dragleave', () => { item.classList.remove('insert-above', 'insert-below'); });
      item.addEventListener('drop', (e) => {
        e.preventDefault(); clearIndicators();
        const insertAt = getInsertIdx(e);
        const fromIdx = e.dataTransfer.getData('text/x-bookmark-idx');
        const filePath = e.dataTransfer.getData('application/x-file-path');
        if (fromIdx !== '') {
          const fi = parseInt(fromIdx);
          const [moved] = this._bookmarks.splice(fi, 1);
          this._bookmarks.splice(fi < insertAt ? insertAt - 1 : insertAt, 0, moved);
          this._saveBookmarks(); this._renderBookmarks();
        } else if (filePath) {
          const label = filePath.split('/').pop() || filePath;
          if (!this._bookmarks.some(b => b.path === filePath)) {
            this._bookmarks.splice(insertAt, 0, { label, path: filePath });
            this._saveBookmarks(); this._renderBookmarks();
          }
        }
      });
      // Right-click: context menu via showContextMenu
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Open', action: () => this.navigate(bk.path) },
          { label: 'Open in new window', action: () => this.app.openFileExplorer(bk.path) },
          { label: 'Remove from bookmarks', action: () => {
            this._bookmarks.splice(i, 1);
            this._saveBookmarks(); this._renderBookmarks();
          }},
          { label: 'Rename bookmark', action: () => {
            const n = prompt('Bookmark name:', bk.label);
            if (n && n.trim()) { bk.label = n.trim(); this._saveBookmarks(); this._renderBookmarks(); }
          }},
        ]);
      });
      this._bookmarkList.appendChild(item);
    });
    // Drop zone at bottom
    const dropZone = document.createElement('div');
    dropZone.className = 'file-bookmark-dropzone';
    dropZone.textContent = this._bookmarks.length === 0 ? 'Drop folders here' : '';
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault(); dropZone.classList.remove('drag-over');
      const filePath = e.dataTransfer.getData('application/x-file-path') || e.dataTransfer.getData('text/plain');
      if (filePath && filePath.startsWith('/')) {
        const label = filePath.split('/').pop() || filePath;
        if (!this._bookmarks.some(b => b.path === filePath)) {
          this._bookmarks.push({ label, path: filePath });
          this._saveBookmarks(); this._renderBookmarks();
        }
      }
    });
    this._bookmarkList.appendChild(dropZone);
  }

  _bookmarkCurrent() {
    if (!this.currentPath) return;
    if (this._bookmarks.some(b => b.path === this.currentPath)) return;
    const label = this.currentPath.split('/').pop() || this.currentPath;
    this._bookmarks.push({ label, path: this.currentPath });
    this._saveBookmarks();
    this._renderBookmarks();
  }

  // ── View menu (replaces old settings, view mode, group by buttons) ──
  _showViewMenu(anchor) {
    const pop = createPopover(anchor, 'file-view-menu');
    const rebuild = () => { pop.remove(); this._showViewMenu(anchor); };

    // Section: View Mode
    this._viewMenuSection(pop, 'View Mode');
    this._viewMenuRadio(pop, [
      { label: 'List', value: 'list' },
      { label: 'Icons', value: 'icon' },
    ], this._viewMode, (v) => {
      this._viewMode = v;
      this._renderSortHeader();
      this._renderItems();
      rebuild();
    });

    this._viewMenuSep(pop);

    // Section: Options
    this._viewMenuSection(pop, 'Options');
    this._viewMenuCheckbox(pop, 'Show hidden files', this._showHidden, (v) => {
      this._showHidden = v; this._persistSettings(); this._renderItems();
    });
    this._viewMenuCheckbox(pop, 'Mixed sort (no dirs-first)', this._mixedSort, (v) => {
      this._mixedSort = v; this._persistSettings(); this._renderItems();
    });
    this._viewMenuCheckbox(pop, 'Show bookmarks panel', this._bookmarksPanelVisible, (v) => {
      this._bookmarksPanelVisible = v;
      this._bookmarkPanel.classList.toggle('hidden', !v);
      this._persistSettings();
    });
    this._viewMenuCheckbox(pop, 'Show preview panel', this._previewVisible, (v) => {
      this._previewVisible = v;
      this._previewPanel.classList.toggle('hidden', !v);
      this._persistSettings();
      if (v) this._updatePreview();
    });

    this._viewMenuSep(pop);

    // Section: Group By
    this._viewMenuSection(pop, 'Group By');
    this._viewMenuRadio(pop, [
      { label: 'None', value: 'none' },
      { label: 'Type', value: 'type' },
      { label: 'Modified', value: 'modified' },
      { label: 'Size', value: 'size' },
    ], this._groupBy, (v) => {
      this._groupBy = v;
      this._collapsedGroups.clear();
      localStorage.setItem('fileExplorerGroupBy', v);
      this._renderItems();
      rebuild();
    });

    // Section: Columns (only in list mode)
    if (this._viewMode === 'list') {
      this._viewMenuSep(pop);
      this._viewMenuSection(pop, 'Columns');
      for (const col of ALL_COLUMNS) {
        if (col.alwaysOn) continue;
        this._viewMenuCheckbox(pop, col.label, !!this._columns[col.key], (v) => {
          this._columns[col.key] = v;
          _saveColumns(this._columns);
          this._renderSortHeader();
          this._renderItems();
        });
      }
    }

    // Position: align right edge to anchor right edge
    requestAnimationFrame(() => {
      const anchorRect = anchor.getBoundingClientRect();
      const popRect = pop.getBoundingClientRect();
      const left = anchorRect.right - popRect.width;
      pop.style.left = Math.max(4, left) + 'px';
    });
  }

  _viewMenuSection(pop, title) {
    const el = document.createElement('div');
    el.className = 'file-view-menu-section';
    el.textContent = title;
    pop.appendChild(el);
  }

  _viewMenuSep(pop) {
    const el = document.createElement('div');
    el.className = 'file-view-menu-sep';
    pop.appendChild(el);
  }

  _viewMenuRadio(pop, options, current, onChange) {
    for (const opt of options) {
      const row = document.createElement('div');
      row.className = 'file-view-menu-item';
      if (opt.value === current) row.classList.add('active');
      const radio = document.createElement('span');
      radio.className = 'file-view-menu-radio';
      radio.textContent = opt.value === current ? '\u25CF' : '\u25CB';
      const label = document.createElement('span');
      label.textContent = opt.label;
      label.style.flex = '1';
      row.append(radio, label);
      row.onclick = (e) => { e.stopPropagation(); onChange(opt.value); };
      pop.appendChild(row);
    }
  }

  _viewMenuCheckbox(pop, label, checked, onChange) {
    const row = document.createElement('div');
    row.className = 'file-view-menu-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.style.width = '13px';
    cb.style.height = '13px';
    cb.style.accentColor = 'var(--accent)';
    const txt = document.createElement('span');
    txt.textContent = label;
    row.append(cb, txt);
    row.onclick = (e) => {
      e.stopPropagation();
      if (e.target !== cb) cb.checked = !cb.checked;
      onChange(cb.checked);
    };
    pop.appendChild(row);
  }

  _persistSettings() {
    _saveSettings({
      showHidden: this._showHidden,
      mixedSort: this._mixedSort,
      defaultSort: this._sortBy,
      defaultSortAsc: this._sortAsc,
      bookmarksVisible: this._bookmarksPanelVisible,
      previewVisible: this._previewVisible,
    });
  }

  // ── Column configuration ──
  _getVisibleColumns() {
    return ALL_COLUMNS.filter(c => c.alwaysOn || this._columns[c.key]);
  }

  _showColumnMenu(x, y) {
    const menuItems = ALL_COLUMNS.map(col => {
      const checked = col.alwaysOn || this._columns[col.key];
      return {
        label: (checked ? '\u2611 ' : '\u2610 ') + col.label,
        disabled: !!col.alwaysOn,
        action: () => {
          this._columns[col.key] = !this._columns[col.key];
          _saveColumns(this._columns);
          this._renderSortHeader();
          this._renderItems();
        },
      };
    });
    menuItems.push({ separator: true });
    menuItems.push({ label: 'Auto-fit column widths', action: () => this._autoFitColumns() });
    showContextMenu(x, y, menuItems);
  }

  async _loadHome() { try { const r = await fetch('/api/home'); const d = await r.json(); this.navigate(d.home); } catch { this.navigate('/'); } }

  async navigate(dirPath) {
    try {
      this._renderLimit = 100; // reset batch on navigation
      const res = await fetch(`/api/files?path=${encodeURIComponent(dirPath)}`);
      const data = await res.json();
      if (data.error) {
        // If path is a file (not a directory), open it in a viewer
        const infoRes = await fetch(`/api/file/info?path=${encodeURIComponent(dirPath)}`);
        if (infoRes.ok) {
          const info = await infoRes.json();
          if (!info.isDirectory) { this.app.openFile(dirPath, dirPath.split('/').pop()); return; }
        }
        throw new Error(data.error);
      }
      this.currentPath = data.path; this.pathInput.value = data.path; this.items = data.items;
      this.winInfo._explorerPath = data.path; // for layout persistence
      if (this.winInfo._openSpec) this.winInfo._openSpec.path = data.path; // update for sync
      const maxLen = 40;
      const display = data.path.length > maxLen ? '\u2026' + data.path.slice(-maxLen + 1) : data.path;
      this.app.wm.setTitle(this.winInfo.id, display);
      this._renderItems();
    } catch (err) { this.listEl.innerHTML = `<div class="empty-hint" style="color:var(--red)">${err.message}</div>`; }
  }

  _renderSortHeader() {
    this.sortHeader.innerHTML = '';
    this.sortHeader.style.display = this._viewMode === 'list' ? '' : 'none';
    // Icon spacer to align with file-icon in rows
    const iconSpacer = document.createElement('span');
    iconSpacer.style.cssText = 'width:16px;flex-shrink:0;padding:0 2px';
    this.sortHeader.appendChild(iconSpacer);
    const visCols = this._getVisibleColumns();
    for (const col of visCols) {
      const el = document.createElement('span');
      el.className = 'file-sort-col';
      el.style.width = `var(--col-${col.key}-w, ${col.defaultWidth}px)`;
      el.style.flexShrink = '0';
      el.style.position = 'relative';
      const arrow = this._sortBy === col.key ? (this._sortAsc ? ' \u25B2' : ' \u25BC') : '';
      el.textContent = col.label + arrow;
      el.onclick = () => {
        if (this._sortBy === col.key) this._sortAsc = !this._sortAsc;
        else { this._sortBy = col.key; this._sortAsc = col.key === 'name'; }
        this._persistSettings();
        this._renderSortHeader();
        this._renderItems();
      };

      // Resize handle on every column (name column adjusts flex min-width)
      const handle = document.createElement('div');
      handle.className = 'file-col-resize-handle';
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._startColumnResize(col, el, e);
      });
      el.appendChild(handle);

      this.sortHeader.appendChild(el);
    }
  }

  _startColumnResize(col, headerEl, startEvent) {
    const startX = startEvent.clientX;
    const startWidth = headerEl.getBoundingClientRect().width;
    let currentWidth = startWidth;
    let rafId = null;
    let moved = false;
    const varName = `--col-${col.key}-w`;

    const onMove = (e) => {
      moved = true;
      const dx = e.clientX - startX;
      currentWidth = Math.max(20, startWidth + dx);
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        this._el.style.setProperty(varName, currentWidth + 'px');
      });
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      this._columnWidths[col.key] = Math.round(currentWidth);
      this._saveColumnWidths();
      this._el.style.setProperty(varName, Math.round(currentWidth) + 'px');
      // Suppress the click event that fires after mouseup to prevent re-sort
      if (moved) {
        headerEl.addEventListener('click', (e) => { e.stopImmediatePropagation(); }, { once: true, capture: true });
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  _getExtension(name) {
    const idx = name.lastIndexOf('.');
    return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
  }

  _getSortedItems() {
    let items = [...this.items];
    if (!this._showHidden) items = items.filter(i => !i.name.startsWith('.'));

    const sortFn = (a, b) => {
      let cmp = 0;
      if (this._sortBy === 'name') cmp = a.name.localeCompare(b.name);
      else if (this._sortBy === 'size') cmp = (a.size || 0) - (b.size || 0);
      else if (this._sortBy === 'modified') cmp = (a.modified || 0) - (b.modified || 0);
      else if (this._sortBy === 'created') cmp = (a.created || 0) - (b.created || 0);
      else if (this._sortBy === 'type') cmp = this._getExtension(a.name).localeCompare(this._getExtension(b.name));
      return this._sortAsc ? cmp : -cmp;
    };

    if (this._mixedSort) {
      items.sort(sortFn);
      return items;
    }

    // Dirs first, then sort within each group
    const dirs = items.filter(i => i.isDirectory);
    const files = items.filter(i => !i.isDirectory);
    dirs.sort(sortFn);
    files.sort(sortFn);
    return [...dirs, ...files];
  }

  _formatDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }

  _renderItems() {
    const sorted = this._getSortedItems();
    this.listEl.innerHTML = '';
    this.listEl.className = 'file-list' + (this._viewMode === 'icon' ? ' icon-view' : '');

    const groups = this._groupItems(sorted);
    if (groups) {
      // Grouped rendering
      if (this._viewMode === 'icon') this.listEl.classList.add('grouped');
      let totalRendered = 0;
      for (const [groupName, groupItems] of groups) {
        const isCollapsed = this._collapsedGroups.has(groupName);

        const header = document.createElement('div'); header.className = 'file-group-header';
        const chevron = document.createElement('span'); chevron.className = 'file-group-chevron';
        chevron.textContent = isCollapsed ? '\u25B6' : '\u25BC';
        const label = document.createElement('span'); label.className = 'file-group-label';
        label.textContent = groupName;
        const count = document.createElement('span'); count.className = 'file-group-count';
        count.textContent = groupItems.length;
        header.append(chevron, label, count);
        header.onclick = () => {
          if (this._collapsedGroups.has(groupName)) this._collapsedGroups.delete(groupName);
          else this._collapsedGroups.add(groupName);
          this._renderItems();
        };
        this.listEl.appendChild(header);

        if (isCollapsed) continue;

        const body = document.createElement('div'); body.className = 'file-group-body';
        if (this._viewMode === 'icon') body.classList.add('icon-view');
        const visible = groupItems.slice(0, Math.max(0, this._renderLimit - totalRendered));
        for (const item of visible) {
          body.appendChild(this._renderFileItem(item));
        }
        totalRendered += visible.length;
        this.listEl.appendChild(body);
        if (totalRendered >= this._renderLimit) break;
      }
      const totalItems = [...groups.values()].reduce((sum, g) => sum + g.length, 0);
      const remaining = totalItems - this._renderLimit;
      if (remaining > 0) {
        const loadMoreBtn = document.createElement('div'); loadMoreBtn.className = 'file-load-more';
        loadMoreBtn.textContent = `Load more (${remaining} remaining)`;
        loadMoreBtn.onclick = () => { this._renderLimit += 100; this._renderItems(); };
        this.listEl.appendChild(loadMoreBtn);
      }
    } else {
      // Flat rendering (no grouping)
      const visible = sorted.slice(0, this._renderLimit);
      for (const item of visible) {
        this.listEl.appendChild(this._renderFileItem(item));
      }
      const remaining = sorted.length - this._renderLimit;
      if (remaining > 0) {
        const loadMoreBtn = document.createElement('div'); loadMoreBtn.className = 'file-load-more';
        loadMoreBtn.textContent = `Load more (${remaining} remaining)`;
        loadMoreBtn.onclick = () => { this._renderLimit += 100; this._renderItems(); };
        this.listEl.appendChild(loadMoreBtn);
      }
    }
  }

  _renderFileItem(item) {
    const fullPath = this.currentPath + '/' + item.name;

    if (this._viewMode === 'icon') {
      const cell = document.createElement('div'); cell.className = 'file-icon-cell';
      cell.dataset.name = item.name; cell.dataset.isDir = item.isDirectory;
      const icon = document.createElement('div'); icon.className = 'file-icon-large';
      icon.innerHTML = item.isDirectory ? FILE_ICONS.folder : getFileIcon(item.name);
      const label = document.createElement('div'); label.className = 'file-icon-label'; label.textContent = item.name;
      cell.append(icon, label);
      cell.draggable = true;
      cell.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', fullPath); e.dataTransfer.setData('application/x-file-path', fullPath); if (item.isDirectory) e.dataTransfer.setData('application/x-folder-path', fullPath); });
      cell.addEventListener('click', () => {
        this.listEl.querySelectorAll('.file-icon-cell').forEach(c => c.classList.remove('selected'));
        cell.classList.add('selected');
        this._selectedPath = item.isDirectory ? null : fullPath;
        this._updatePreview();
      });
      cell.addEventListener('dblclick', () => {
        if (item.isDirectory) this.navigate(fullPath);
        else this.app.openFile(fullPath, item.name);
      });
      return cell;
    } else {
      const row = document.createElement('div'); row.className = 'file-item';
      row.dataset.name = item.name; row.dataset.isDir = item.isDirectory;
      const iconEl = document.createElement('span'); iconEl.className = 'file-icon'; iconEl.innerHTML = item.isDirectory ? FILE_ICONS.folder : getFileIcon(item.name);
      row.appendChild(iconEl);

      const visCols = this._getVisibleColumns();
      for (const col of visCols) {
        if (col.key === 'name') {
          const nameEl = document.createElement('span'); nameEl.className = 'file-name'; nameEl.textContent = item.name;
          row.appendChild(nameEl);
        } else if (col.key === 'size') {
          const sizeEl = document.createElement('span'); sizeEl.className = 'file-meta file-size'; sizeEl.textContent = item.isDirectory ? '' : formatSize(item.size);
          row.appendChild(sizeEl);
        } else if (col.key === 'modified') {
          const modEl = document.createElement('span'); modEl.className = 'file-meta file-modified';
          modEl.textContent = this._formatDate(item.modified);
          row.appendChild(modEl);
        } else if (col.key === 'created') {
          const crEl = document.createElement('span'); crEl.className = 'file-meta file-created';
          crEl.textContent = this._formatDate(item.created);
          row.appendChild(crEl);
        } else if (col.key === 'type') {
          const tyEl = document.createElement('span'); tyEl.className = 'file-meta file-type';
          tyEl.textContent = item.isDirectory ? 'dir' : (this._getExtension(item.name) || '-');
          row.appendChild(tyEl);
        }
      }

      row.draggable = true;
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', fullPath); e.dataTransfer.setData('application/x-file-path', fullPath); if (item.isDirectory) e.dataTransfer.setData('application/x-folder-path', fullPath); });
      row.addEventListener('click', () => {
        this.listEl.querySelectorAll('.file-item').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        this._selectedPath = item.isDirectory ? null : fullPath;
        this._updatePreview();
      });
      row.addEventListener('dblclick', () => {
        if (item.isDirectory) this.navigate(fullPath);
        else this.app.openFile(fullPath, item.name);
      });
      return row;
    }
  }

  navigateUp() { this.navigate(this.currentPath.replace(/\/[^/]+\/?$/, '') || '/'); }
  refresh() { this.navigate(this.currentPath); }

  async createFile() { const n = prompt('File name:'); if (n) { await fetch('/api/file/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: this.currentPath + '/' + n, content: '' }) }); this.refresh(); } }
  async createDir() { const n = prompt('Folder name:'); if (n) { await fetch('/api/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: this.currentPath + '/' + n }) }); this.refresh(); } }

  // ── Upload popover menu (Chrome download-button style) ──
  _triggerUpload(anchor) {
    const pop = createPopover(anchor, 'upload-popover');
    // Upload Files
    const fileBtn = document.createElement('div'); fileBtn.className = 'upload-menu-item';
    fileBtn.innerHTML = `${UI_ICONS.upload} Upload Files`;
    fileBtn.onclick = () => { pop.remove(); this.uploadInput.click(); };
    // Upload Folder
    const folderBtn = document.createElement('div'); folderBtn.className = 'upload-menu-item';
    folderBtn.innerHTML = `${FILE_ICONS.folder} Upload Folder`;
    folderBtn.onclick = () => { pop.remove(); this._folderInput.click(); };
    pop.append(fileBtn, folderBtn);

    // Active uploads section
    if (this._activeUploads.size > 0) {
      const divider = document.createElement('div'); divider.className = 'upload-menu-divider';
      pop.appendChild(divider);
      const activeLabel = document.createElement('div'); activeLabel.className = 'upload-menu-label'; activeLabel.textContent = 'Uploading';
      pop.appendChild(activeLabel);
      for (const [id, upload] of this._activeUploads) {
        const item = document.createElement('div'); item.className = 'upload-active-item';
        // Row 1: spinner + name + cancel
        const row1 = document.createElement('div'); row1.className = 'upload-active-row1';
        const spinner = document.createElement('span'); spinner.className = 'upload-active-spinner';
        const nameList = upload.rows.map(r => r.el.querySelector('.file-name')?.textContent).filter(Boolean);
        const label = nameList.length > 1 ? `${nameList.length} files` : (nameList[0] || 'uploading...');
        const name = document.createElement('span'); name.className = 'upload-active-name'; name.textContent = label;
        const cancelBtn = document.createElement('span'); cancelBtn.className = 'upload-active-cancel'; cancelBtn.textContent = '\u2715';
        cancelBtn.onclick = (e) => { e.stopPropagation(); upload.xhr.abort(); pop.remove(); };
        row1.append(spinner, name, cancelBtn);
        // Row 2: progress bar + size
        const row2 = document.createElement('div'); row2.className = 'upload-active-row2';
        const track = document.createElement('span'); track.className = 'upload-active-track';
        const fill = document.createElement('span'); fill.className = 'upload-active-fill';
        // Read current progress from inline row
        const curFill = upload.rows[0]?.fill;
        if (curFill) fill.style.width = curFill.style.width;
        track.appendChild(fill);
        const totalSize = upload.files.reduce((s, f) => s + f.size, 0);
        const sizeLabel = document.createElement('span'); sizeLabel.className = 'upload-active-size';
        sizeLabel.textContent = formatSize(totalSize);
        row2.append(track, sizeLabel);
        item.append(row1, row2);
        pop.appendChild(item);
      }
    }

    // History section
    const sync = getStateSync();
    const historyData = sync ? this._getUploadHistory(sync) : [];
    if (historyData.length > 0) {
      const divider = document.createElement('div'); divider.className = 'upload-menu-divider';
      pop.appendChild(divider);
      const histLabel = document.createElement('div'); histLabel.className = 'upload-menu-label'; histLabel.textContent = 'Recent Uploads';
      pop.appendChild(histLabel);
      for (const entry of historyData.slice(0, 10)) {
        const item = document.createElement('div'); item.className = 'upload-history-item';
        // Row 1: icon + name + status
        const row1 = document.createElement('div'); row1.className = 'upload-hist-row1';
        const icon = document.createElement('span'); icon.innerHTML = getFileIcon(entry.name);
        const name = document.createElement('span'); name.className = 'upload-hist-name'; name.textContent = entry.name;
        const statusIcon = document.createElement('span'); statusIcon.className = 'upload-hist-status';
        statusIcon.textContent = entry.status === 'ok' ? '\u2713' : entry.status === 'fail' ? '\u2717' : '\u2026';
        row1.append(icon, name, statusIcon);
        // Row 2: size + date
        const row2 = document.createElement('div'); row2.className = 'upload-hist-row2';
        row2.textContent = `${formatSize(entry.size)} · ${this._formatDate(entry.date)}`;
        item.append(row1, row2);
        item.onclick = () => { pop.remove(); if (entry.path) this.app.openFile(entry.path, entry.name); };
        pop.appendChild(item);
      }
      if (historyData.length > 0) {
        const clearBtn = document.createElement('div'); clearBtn.className = 'upload-menu-item upload-menu-clear';
        clearBtn.textContent = 'Clear History';
        clearBtn.onclick = () => { pop.remove(); this._clearUploadHistory(); };
        pop.appendChild(clearBtn);
      }
    }
  }

  _getUploadHistory(sync) {
    const all = [];
    const data = sync.getAll('uploads');
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith('upload:') && val) {
        try { all.push(typeof val === 'string' ? JSON.parse(val) : val); } catch {}
      }
    }
    all.sort((a, b) => (b.date || 0) - (a.date || 0));
    return all;
  }

  _clearUploadHistory() {
    const sync = getStateSync();
    if (!sync) return;
    const data = sync.getAll('uploads');
    for (const key of Object.keys(data)) {
      if (key.startsWith('upload:')) sync.set('uploads', key, '');
    }
  }

  _saveUploadHistory(files, status) {
    const sync = getStateSync();
    if (!sync) return;
    const now = Date.now();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const key = `upload:${now}-${i}`;
      sync.set('uploads', key, {
        name: f.name, path: f.destPath || '', size: f.size || 0,
        date: now, status,
      });
    }
  }

  // ── Upload with inline file-list progress ──
  _uploadFiles(fileList, isFolder = false) {
    const files = [...fileList];
    if (!files.length) return;
    const uploadId = Date.now() + '-' + Math.random().toString(36).slice(2, 6);

    // Build FormData — for folders, preserve relative paths via webkitRelativePath
    const fd = new FormData(); fd.append('destDir', this.currentPath);
    const names = [];
    const relPaths = [];
    for (const f of files) {
      fd.append('files', f);
      const rel = isFolder && f.webkitRelativePath ? f.webkitRelativePath : f.name;
      names.push(rel);
      relPaths.push(rel);
    }
    fd.append('fileNames', JSON.stringify(names));
    if (isFolder) fd.append('preservePaths', '1');

    // Insert placeholder rows into the file list (Mac Finder style)
    const rows = [];
    // For folder uploads: show one row per unique top-level entry
    const displayNames = isFolder
      ? [...new Set(relPaths.map(r => r.split('/')[0]))]
      : names;
    for (const displayName of displayNames) {
      const row = document.createElement('div'); row.className = 'file-item file-uploading';
      const iconEl = document.createElement('span'); iconEl.className = 'file-icon';
      iconEl.innerHTML = isFolder && displayNames.length === 1 ? FILE_ICONS.folder : getFileIcon(displayName);
      const nameEl = document.createElement('span'); nameEl.className = 'file-name'; nameEl.textContent = displayName;
      // Mac Finder style: progress bar fills the remaining space after the name
      const progressWrap = document.createElement('span'); progressWrap.className = 'file-upload-progress';
      const progressTrack = document.createElement('span'); progressTrack.className = 'file-upload-track';
      const progressFill = document.createElement('span'); progressFill.className = 'file-upload-fill';
      progressTrack.appendChild(progressFill);
      const pctLabel = document.createElement('span'); pctLabel.className = 'file-upload-pct'; pctLabel.textContent = '0%';
      const cancelBtn = document.createElement('button'); cancelBtn.className = 'file-upload-cancel'; cancelBtn.textContent = '\u2715';
      cancelBtn.title = 'Cancel upload';
      progressWrap.append(progressTrack, pctLabel, cancelBtn);
      row.append(iconEl, nameEl, progressWrap);
      // Insert at top of file list
      if (this.listEl.firstChild) this.listEl.insertBefore(row, this.listEl.firstChild);
      else this.listEl.appendChild(row);
      rows.push({ el: row, fill: progressFill, pctLabel });
    }

    const xhr = new XMLHttpRequest();
    this._activeUploads.set(uploadId, { xhr, files, rows });

    cancelBtn: {
      for (const r of rows) {
        r.el.querySelector('.file-upload-cancel').onclick = () => xhr.abort();
      }
    }

    // Show ring on upload button
    this._uploadRingSvg.classList.remove('hidden');

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round(e.loaded / e.total * 100);
      for (const r of rows) {
        r.fill.style.width = pct + '%';
        r.pctLabel.textContent = pct + '%';
      }
      // Update ring progress
      const offset = this._ringCircumference * (1 - pct / 100);
      this._uploadRing.setAttribute('stroke-dashoffset', offset);
    };

    xhr.onload = () => {
      this._activeUploads.delete(uploadId);
      this._updateUploadRing();
      let resultFiles = files.map((f, i) => ({ name: names[i], size: f.size, destPath: this.currentPath + '/' + names[i] }));
      try {
        const resp = JSON.parse(xhr.responseText);
        if (resp.files) resultFiles = resp.files.map(f => ({ name: f.name, size: f.size, destPath: f.path }));
      } catch {}
      this._saveUploadHistory(resultFiles, 'ok');
      for (const r of rows) { r.fill.style.width = '100%'; r.pctLabel.textContent = '100%'; r.el.classList.add('file-upload-done'); }
      setTimeout(() => this.refresh(), 800);
    };

    xhr.onerror = () => {
      this._activeUploads.delete(uploadId);
      this._updateUploadRing();
      this._saveUploadHistory(files.map((f, i) => ({ name: names[i], size: f.size })), 'fail');
      for (const r of rows) { r.el.classList.add('file-upload-error'); r.pctLabel.textContent = 'Failed'; }
      setTimeout(() => { for (const r of rows) r.el.remove(); }, 3000);
    };

    xhr.onabort = () => {
      this._activeUploads.delete(uploadId);
      this._updateUploadRing();
      for (const r of rows) r.el.remove();
    };

    xhr.open('POST', '/api/upload');
    xhr.send(fd);
  }

  _updateUploadRing() {
    if (this._activeUploads.size === 0) {
      this._uploadRingSvg.classList.add('hidden');
      this._uploadRing.setAttribute('stroke-dashoffset', this._ringCircumference);
    }
  }

  _showContextMenu(x, y, dataset) {
    document.querySelectorAll('.context-menu').forEach(m => m.remove());
    const menu = document.createElement('div'); menu.className = 'context-menu';
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    const fullPath = this.currentPath + '/' + dataset.name;
    const items = [];
    items.push({ label: 'Copy Path', action: () => {
      navigator.clipboard?.writeText(fullPath).catch(() => {
        const ta = document.createElement('textarea'); ta.value = fullPath; ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      });
    }});
    if (dataset.isDir === 'true') {
      const isBookmarked = this._bookmarks.some(b => b.path === fullPath);
      items.push({ label: isBookmarked ? '\u2605 Bookmarked' : '\u2606 Add to bookmarks', action: () => {
        if (!isBookmarked) {
          const label = dataset.name || fullPath.split('/').pop();
          this._bookmarks.push({ label, path: fullPath });
          this._saveBookmarks(); this._renderBookmarks();
        }
      }});
      items.push({ label: 'Sessions', submenu: () => {
        const sub = [];
        sub.push({ label: '+ New session', action: () => this.app.createSession({ cwd: fullPath }) });
        const sessionsHere = (this.app.sidebar?._allSessions || []).filter(s => s.cwd === fullPath);
        for (const s of sessionsHere) {
          const customName = this.app.sidebar?.getCustomName(s);
          const dispName = customName || s.name || s.sessionId.substring(0, 12) + '...';
          const badge = s.status === 'live' ? '\u25CF ' : s.status === 'tmux' ? '\u25C6 ' : '';
          const agentOpts = {
            backend: s.backend || 'claude',
            backendSessionId: s.backendSessionId || s.sessionId,
            agentKind: s.agentKind || 'primary',
            agentRole: s.agentRole || '',
            agentNickname: s.agentNickname || '',
            sourceKind: s.sourceKind || '',
            parentThreadId: s.parentThreadId || null,
          };
          sub.push({ label: `${badge}${dispName}`, action: () => {
            if (s.status === 'stopped') this.app.resumeSession(s.sessionId, s.cwd, customName || s.name, agentOpts);
            else if (s.status === 'live' && s.webuiId) this.app.attachSession(s.webuiId, s.webuiName || dispName, s.cwd, { mode: s.webuiMode, ...agentOpts });
            else if (s.status === 'tmux') this.app.attachTmuxSession(s.tmuxTarget, dispName, s.cwd);
          }});
        }
        return sub;
      }});
      // Link folder to a session group
      const groupNames = this.app.sidebar?._getGroupNames() || [];
      if (groupNames.length > 0) {
        items.push({ label: 'Add to group', submenu: () => {
          return groupNames.map(g => ({ label: g, action: () => this.app.sidebar?._addFolderToGroup(fullPath, g) }));
        }});
      }
    } else {
      items.push({ label: 'Open', action: () => this.app.openFile(fullPath, dataset.name) });
      items.push({ label: 'Edit', action: () => this.app.openEditor(fullPath, dataset.name) });
      items.push({ label: 'Open as Hex', action: () => this.app.openFile(fullPath, dataset.name, { hex: true }) });
      items.push({ label: 'Download', action: () => { window.open(`/api/download?path=${encodeURIComponent(fullPath)}`); } });
    }
    items.push({ label: 'Rename', action: () => this._rename(dataset.name) });
    items.push({ label: 'Delete', action: () => this._delete(dataset.name, dataset.isDir === 'true') });

    for (const item of items) {
      const el = document.createElement('div'); el.className = 'context-menu-item'; el.textContent = item.label;
      if (item.submenu) {
        el.classList.add('has-submenu');
        el.onmouseenter = () => {
          menu.querySelectorAll('.context-submenu').forEach(s => s.remove());
          const subItems = item.submenu();
          const sub = document.createElement('div'); sub.className = 'context-menu context-submenu';
          sub.style.left = menu.offsetWidth + 'px'; sub.style.top = (el.offsetTop - menu.scrollTop) + 'px';
          for (const si of subItems) {
            const se = document.createElement('div'); se.className = 'context-menu-item'; se.textContent = si.label;
            se.onclick = () => { menu.remove(); si.action(); };
            sub.appendChild(se);
          }
          menu.appendChild(sub);
        };
      } else {
        el.onclick = () => { menu.remove(); item.action(); };
      }
      menu.appendChild(el);
    }
    document.body.appendChild(menu);
    attachPopoverClose(menu);
  }

  async _rename(oldName) { const n = prompt('New name:', oldName); if (n && n !== oldName) { await fetch('/api/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPath: this.currentPath + '/' + oldName, newPath: this.currentPath + '/' + n }) }); this.refresh(); } }
  async _delete(name, isDir) { if (!confirm(`Delete "${name}"?`)) return; await fetch(`/api/file?path=${encodeURIComponent(this.currentPath + '/' + name)}`, { method: 'DELETE' }); this.refresh(); }

  _getFileExtension(name) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return '(no extension)';
    return name.substring(dot).toLowerCase();
  }

  _getModifiedGroup(ts) {
    if (!ts) return 'Unknown';
    const now = new Date();
    const d = new Date(ts);
    const diffMs = now - d;
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today - 86400000);
    const fileDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

    if (fileDay >= today) return 'Today';
    if (fileDay >= yesterday) return 'Yesterday';
    if (diffDays < 7) return 'This Week';
    if (diffDays < 30) return 'This Month';
    return 'Older';
  }

  _getSizeGroup(size) {
    if (size == null) return 'Unknown';
    if (size < 1024) return 'Tiny (<1 KB)';
    if (size < 102400) return 'Small (<100 KB)';
    if (size < 1048576) return 'Medium (<1 MB)';
    if (size < 10485760) return 'Large (<10 MB)';
    return 'Huge (>10 MB)';
  }

  _groupItems(sorted) {
    if (this._groupBy === 'none') return null;

    const groups = new Map();
    for (const item of sorted) {
      let key;
      if (this._groupBy === 'type') {
        key = item.isDirectory ? 'Folders' : this._getFileExtension(item.name);
      } else if (this._groupBy === 'modified') {
        key = this._getModifiedGroup(item.modified);
      } else if (this._groupBy === 'size') {
        key = item.isDirectory ? 'Folders' : this._getSizeGroup(item.size);
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    if (this._groupBy === 'modified') {
      const order = ['Today', 'Yesterday', 'This Week', 'This Month', 'Older', 'Unknown'];
      return new Map(order.filter(k => groups.has(k)).map(k => [k, groups.get(k)]));
    }
    if (this._groupBy === 'size') {
      const order = ['Folders', 'Tiny (<1 KB)', 'Small (<100 KB)', 'Medium (<1 MB)', 'Large (<10 MB)', 'Huge (>10 MB)', 'Unknown'];
      return new Map(order.filter(k => groups.has(k)).map(k => [k, groups.get(k)]));
    }
    const result = new Map();
    if (groups.has('Folders')) { result.set('Folders', groups.get('Folders')); groups.delete('Folders'); }
    const extKeys = [...groups.keys()].sort();
    for (const k of extKeys) result.set(k, groups.get(k));
    return result;
  }

  _setupPathAutocomplete() {
    const ac = setupDirAutocomplete(this.pathInput, this._acDropdown, {
      onNavigate: (path) => this.navigate(path),
    });
    this._hideAC = ac.hide;
  }

  _autoFitColumns() {
    const classMap = { size: '.file-size', modified: '.file-modified', created: '.file-created', type: '.file-type' };
    for (const col of this._getVisibleColumns().filter(c => !c.alwaysOn)) {
      const sel = classMap[col.key];
      if (!sel) continue;
      let maxW = 40;
      for (const cell of this.listEl.querySelectorAll(sel)) {
        const sw = cell.style.width; cell.style.width = 'auto'; cell.style.whiteSpace = 'nowrap';
        const w = cell.scrollWidth + 8;
        cell.style.width = sw; cell.style.whiteSpace = '';
        if (w > maxW) maxW = w;
      }
      this._columnWidths[col.key] = Math.round(maxW);
      this._el.style.setProperty(`--col-${col.key}-w`, Math.round(maxW) + 'px');
    }
    this._saveColumnWidths();
  }

  // ── Preview Panel ──

  _updatePreviewLayout() {
    if (!this._previewVisible || this._previewPanel.classList.contains('hidden')) return;
    const rect = this._contentArea.getBoundingClientRect();
    const isWide = rect.width > rect.height * 1.3;
    this._contentArea.classList.toggle('preview-horizontal', isWide);
    this._contentArea.classList.toggle('preview-vertical', !isWide);
  }

  async _updatePreview() {
    if (!this._previewVisible) return;
    if (!this._selectedPath) {
      this._previewTitle.textContent = 'No file selected';
      this._previewContent.innerHTML = '<div class="empty-hint">Select a file to preview</div>';
      return;
    }
    const fp = this._selectedPath;
    const name = fp.split('/').pop();
    const ext = name.split('.').pop().toLowerCase();
    const rawUrl = `/api/file/raw?path=${encodeURIComponent(fp)}`;
    this._previewTitle.textContent = name;
    this._previewContent.innerHTML = '<div class="empty-hint">Loading...</div>';

    try {
      // Try dedicated viewer first (reuses FileViewer.renderInto for all formats)
      this._previewContent.innerHTML = '';
      const rendered = await FileViewer.renderInto(this._previewContent, fp, name);
      if (rendered) return;

      // Fallback: text preview for non-binary files
      const infoRes = await fetch(`/api/file/info?path=${encodeURIComponent(fp)}`);
      const info = await infoRes.json();
      if (info.error) { this._previewContent.innerHTML = `<div class="empty-hint">${info.error}</div>`; return; }
      if (info.isBinary) {
        this._previewContent.innerHTML = `<div class="empty-hint">${formatSize(info.size)} binary file</div>`;
        return;
      }
      if (info.size > 512 * 1024) {
        this._previewContent.innerHTML = `<div class="empty-hint">${formatSize(info.size)} — too large to preview</div>`;
        return;
      }
      const res = await fetch(`/api/file/content?path=${encodeURIComponent(fp)}`);
      const data = await res.json();
      if (data.error) { this._previewContent.innerHTML = `<div class="empty-hint">${data.error}</div>`; return; }
      const pre = document.createElement('pre');
      pre.className = 'file-preview-code';
      pre.textContent = data.content;
      this._previewContent.appendChild(pre);
    } catch (err) {
      this._previewContent.innerHTML = `<div class="empty-hint">Error: ${err.message}</div>`;
    }
  }

}

export { FileExplorer };
