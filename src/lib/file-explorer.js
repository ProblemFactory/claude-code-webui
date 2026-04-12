import { formatSize, attachPopoverClose, createPopover, showContextMenu } from './utils.js';
import { setupDirAutocomplete } from './autocomplete.js';

const DEFAULT_COLUMNS = { name: true, size: true, modified: true, created: false, type: false };
const ALL_COLUMNS = [
  { key: 'name', label: 'Name', flex: 1, alwaysOn: true },
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
    const btnView = this._btn('View \u25BE', 'View options');
    btnView.style.width = 'auto';
    btnView.style.padding = '2px 6px';
    btnView.style.fontSize = '11px';
    btnView.onclick = () => this._showViewMenu(btnView);

    const btnNewFile = this._btn('+', 'New file'); btnNewFile.onclick = () => this.createFile();
    const btnNewDir = this._btn('\uD83D\uDCC2', 'New folder'); btnNewDir.onclick = () => this.createDir();
    const btnUpload = this._btn('\u2B06', 'Upload'); btnUpload.onclick = () => this._triggerUpload();

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

    // Content area (bookmark panel + main pane)
    const contentArea = document.createElement('div'); contentArea.className = 'file-content-area';
    this.listEl = document.createElement('div'); this.listEl.className = 'file-list';

    // Main pane wraps sort header + file list (so columns align with bookmarks panel open)
    const mainPane = document.createElement('div');
    mainPane.className = 'file-main-pane';
    mainPane.append(this.sortHeader, this.listEl);

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

    contentArea.append(this._bookmarkPanel, mainPane, this._previewPanel);
    this._contentArea = contentArea;
    this._el = el;
    // Auto-detect preview layout direction based on window aspect ratio
    this._previewRO = new ResizeObserver(() => this._updatePreviewLayout());
    this._previewRO.observe(contentArea);

    // Upload drop zone
    this.uploadInput = document.createElement('input'); this.uploadInput.type = 'file'; this.uploadInput.multiple = true;
    this.uploadInput.style.display = 'none';
    this.uploadInput.onchange = (e) => this._uploadFiles(e.target.files);

    el.append(toolbar, contentArea, this.uploadInput);
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
        action: () => {
          if (col.alwaysOn) return;
          this._columns[col.key] = !this._columns[col.key];
          _saveColumns(this._columns);
          this._renderSortHeader();
          this._renderItems();
        },
      };
    });
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
      this.app.wm.setTitle(this.winInfo.id, `\uD83D\uDCC1 ${display}`);
      this._renderItems();
    } catch (err) { this.listEl.innerHTML = `<div class="empty-hint" style="color:var(--red)">${err.message}</div>`; }
  }

  _renderSortHeader() {
    this.sortHeader.innerHTML = '';
    this.sortHeader.style.display = this._viewMode === 'list' ? '' : 'none';
    const visCols = this._getVisibleColumns();
    for (const col of visCols) {
      const el = document.createElement('span');
      el.className = 'file-sort-col';
      if (col.alwaysOn) {
        // Name column: flex, with optional minWidth
        el.style.flex = '1';
        el.style.minWidth = '0';
      } else {
        el.style.width = `var(--col-${col.key}-w, ${col.defaultWidth}px)`;
        el.style.flexShrink = '0';
      }
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

      // Resize handle (not on name column since it uses flex)
      if (!col.alwaysOn) {
        const handle = document.createElement('div');
        handle.className = 'file-col-resize-handle';
        handle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._startColumnResize(col, el, e);
        });
        el.appendChild(handle);
      }

      this.sortHeader.appendChild(el);
    }
  }

  _startColumnResize(col, headerEl, startEvent) {
    const startX = startEvent.clientX;
    const startWidth = headerEl.getBoundingClientRect().width;
    let currentWidth = startWidth;
    let rafId = null;

    const onMove = (e) => {
      const dx = e.clientX - startX;
      currentWidth = Math.max(40, startWidth + dx);
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        this._el.style.setProperty(`--col-${col.key}-w`, currentWidth + 'px');
      });
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      this._columnWidths[col.key] = Math.round(currentWidth);
      this._saveColumnWidths();
      this._el.style.setProperty(`--col-${col.key}-w`, Math.round(currentWidth) + 'px');
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
    return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
      icon.textContent = item.isDirectory ? '\u{1F4C1}' : this._fileIcon(item.name);
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
      const iconEl = document.createElement('span'); iconEl.className = 'file-icon'; iconEl.textContent = item.isDirectory ? '\u{1F4C1}' : this._fileIcon(item.name);
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

  _triggerUpload() { this.uploadInput.click(); }

  async _uploadFiles(files) {
    const fd = new FormData(); fd.append('destDir', this.currentPath);
    for (const f of files) fd.append('files', f);
    try { await fetch('/api/upload', { method: 'POST', body: fd }); this.refresh(); } catch {}
  }

  _showContextMenu(x, y, dataset) {
    document.querySelectorAll('.context-menu').forEach(m => m.remove());
    const menu = document.createElement('div'); menu.className = 'context-menu';
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    const fullPath = this.currentPath + '/' + dataset.name;
    const items = [];
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
          const customName = this.app.sidebar?.getCustomName(s.sessionId);
          const dispName = customName || s.name || s.sessionId.substring(0, 12) + '...';
          const badge = s.status === 'live' ? '\u25CF ' : s.status === 'tmux' ? '\u25C6 ' : '';
          sub.push({ label: `${badge}${dispName}`, action: () => {
            if (s.status === 'stopped') this.app.resumeSession(s.sessionId, s.cwd, customName || s.name);
            else if (s.status === 'live' && s.webuiId) this.app.attachSession(s.webuiId, s.webuiName || dispName, s.cwd);
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
    this._previewTitle.textContent = name;
    this._previewContent.innerHTML = '<div class="empty-hint">Loading...</div>';

    try {
      const infoRes = await fetch(`/api/file/info?path=${encodeURIComponent(fp)}`);
      const info = await infoRes.json();
      if (info.error) { this._previewContent.innerHTML = `<div class="empty-hint">${info.error}</div>`; return; }
      if (info.isBinary) {
        const ext = name.split('.').pop().toLowerCase();
        const imgExts = ['png','jpg','jpeg','gif','webp','svg','bmp','ico'];
        if (imgExts.includes(ext)) {
          this._previewContent.innerHTML = `<img src="/api/file/raw?path=${encodeURIComponent(fp)}" style="max-width:100%;max-height:100%;object-fit:contain">`;
        } else {
          this._previewContent.innerHTML = `<div class="empty-hint">${formatSize(info.size)} binary file</div>`;
        }
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
      this._previewContent.innerHTML = '';
      this._previewContent.appendChild(pre);
    } catch (err) {
      this._previewContent.innerHTML = `<div class="empty-hint">Error: ${err.message}</div>`;
    }
  }

  _fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const m = { js: '\uD83D\uDCDC', ts: '\uD83D\uDCDC', py: '\uD83D\uDC0D', go: '\uD83D\uDD37', rs: '\uD83E\uDD80', html: '\uD83C\uDF10', css: '\uD83C\uDFA8', json: '{}', md: '\uD83D\uDCDD', txt: '\uD83D\uDCC4',
      pdf: '\uD83D\uDCD5', doc: '\uD83D\uDCD8', docx: '\uD83D\uDCD8', xls: '\uD83D\uDCCA', xlsx: '\uD83D\uDCCA', csv: '\uD83D\uDCCA',
      jpg: '\uD83D\uDDBC', jpeg: '\uD83D\uDDBC', png: '\uD83D\uDDBC', gif: '\uD83D\uDDBC', svg: '\uD83D\uDDBC', webp: '\uD83D\uDDBC', sh: '\u2699', bash: '\u2699', zsh: '\u2699' };
    return m[ext] || '\uD83D\uDCC4';
  }
}

export { FileExplorer };
