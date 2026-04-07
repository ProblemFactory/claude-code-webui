import { formatSize, attachPopoverClose } from './utils.js';
import { setupDirAutocomplete } from './autocomplete.js';

const DEFAULT_COLUMNS = { name: true, size: true, modified: true, created: false, type: false };
const ALL_COLUMNS = [
  { key: 'name', label: 'Name', flex: 1, alwaysOn: true },
  { key: 'size', label: 'Size', width: '80px' },
  { key: 'modified', label: 'Modified', width: '140px' },
  { key: 'created', label: 'Created', width: '140px' },
  { key: 'type', label: 'Type', width: '70px' },
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
    this._bookmarksPanelVisible = true;

    // Load settings
    const saved = _loadSettings();
    this._showHidden = saved?.showHidden || false;
    this._mixedSort = saved?.mixedSort || false;
    this._sortBy = saved?.defaultSort || 'name';
    this._sortAsc = saved?.defaultSortAsc !== undefined ? saved.defaultSortAsc : true;

    // Grouping (preserved from existing implementation)
    this._groupBy = localStorage.getItem('fileExplorerGroupBy') || 'none';
    this._collapsedGroups = new Set();

    // Load column visibility
    this._columns = _loadColumns();

    const el = document.createElement('div'); el.className = 'file-explorer';

    // Toolbar
    const toolbar = document.createElement('div'); toolbar.className = 'file-toolbar';
    const btnUp = this._btn('\u2191','Go up'); btnUp.onclick = () => this.navigateUp();
    this.pathInput = document.createElement('input'); this.pathInput.className = 'file-path-input';
    this.pathInput.addEventListener('keydown', e => { if (e.key==='Enter') { if (this._hideAC) this._hideAC(); this.navigate(this.pathInput.value); } });
    this._acDropdown = document.createElement('div'); this._acDropdown.className = 'path-autocomplete hidden';
    this._setupPathAutocomplete();
    const btnRefresh = this._btn('\u21BB','Refresh'); btnRefresh.onclick = () => this.refresh();

    // Bookmark current folder button
    const btnBookmark = this._btn('\u2605','Bookmark current folder'); btnBookmark.onclick = () => this._bookmarkCurrent();

    // Bookmark panel toggle
    this._btnBookmarkToggle = this._btn('\u2630','Toggle bookmarks panel');
    this._btnBookmarkToggle.classList.add('active');
    this._btnBookmarkToggle.onclick = () => {
      this._bookmarksPanelVisible = !this._bookmarksPanelVisible;
      this._btnBookmarkToggle.classList.toggle('active', this._bookmarksPanelVisible);
      this._bookmarkPanel.classList.toggle('hidden', !this._bookmarksPanelVisible);
    };

    const btnListView = this._btn('\u2261','List view'); btnListView.onclick = () => { this._viewMode = 'list'; this._renderItems(); btnListView.classList.add('active'); btnIconView.classList.remove('active'); };
    btnListView.classList.add('active');
    const btnIconView = this._btn('\u229E','Icon view'); btnIconView.onclick = () => { this._viewMode = 'icon'; this._renderItems(); btnIconView.classList.add('active'); btnListView.classList.remove('active'); };

    // Group by button (preserved from existing implementation)
    this._btnGroup = this._btn('\u2261','Group by'); this._btnGroup.title = 'Group by: ' + this._groupBy;
    if (this._groupBy !== 'none') this._btnGroup.classList.add('active');
    this._btnGroup.onclick = (e) => { e.stopPropagation(); this._showGroupByMenu(this._btnGroup); };

    const btnNewFile = this._btn('+','New file'); btnNewFile.onclick = () => this.createFile();
    const btnNewDir = this._btn('\uD83D\uDCC2','New folder'); btnNewDir.onclick = () => this.createDir();
    const btnUpload = this._btn('\u2B06','Upload'); btnUpload.onclick = () => this._triggerUpload();

    // Settings button (replaces standalone hidden files toggle)
    const btnSettings = this._btn('\u2699','File explorer settings'); btnSettings.onclick = (e) => this._showSettings(e, btnSettings);

    toolbar.style.position = 'relative';
    toolbar.append(btnUp, this.pathInput, btnRefresh, btnBookmark, this._btnBookmarkToggle, btnListView, btnIconView, this._btnGroup, btnNewFile, btnNewDir, btnUpload, btnSettings, this._acDropdown);

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

    // Content area (bookmark panel + file list)
    const contentArea = document.createElement('div'); contentArea.className = 'file-content-area';
    this.listEl = document.createElement('div'); this.listEl.className = 'file-list';
    contentArea.append(this._bookmarkPanel, this.listEl);

    // Upload drop zone
    this.uploadInput = document.createElement('input'); this.uploadInput.type = 'file'; this.uploadInput.multiple = true;
    this.uploadInput.style.display = 'none';
    this.uploadInput.onchange = (e) => this._uploadFiles(e.target.files);

    el.append(toolbar, this.sortHeader, contentArea, this.uploadInput);
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

  _btn(text, title) { const b = document.createElement('button'); b.className='file-tool-btn'; b.textContent=text; b.title=title; return b; }

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
      // Right-click: show context menu (same as right-clicking the folder in file list)
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const bmItems = [];
        bmItems.push({ label: 'Open', action: () => this.navigate(bk.path) });
        bmItems.push({ label: 'Open in new window', action: () => this.app.openFileExplorer(bk.path) });
        bmItems.push({ label: 'Remove from bookmarks', action: () => {
          this._bookmarks.splice(i, 1);
          this._saveBookmarks(); this._renderBookmarks();
        }});
        bmItems.push({ label: 'Rename bookmark', action: () => {
          const n = prompt('Bookmark name:', bk.label);
          if (n && n.trim()) { bk.label = n.trim(); this._saveBookmarks(); this._renderBookmarks(); }
        }});
        // Show context menu
        document.querySelectorAll('.context-menu').forEach(m => m.remove());
        const menu = document.createElement('div'); menu.className = 'context-menu';
        menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px';
        for (const mi of bmItems) {
          const el = document.createElement('div'); el.className = 'context-menu-item'; el.textContent = mi.label;
          el.onclick = () => { menu.remove(); mi.action(); }; menu.appendChild(el);
        }
        document.body.appendChild(menu);
        attachPopoverClose(menu);
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
    // Check if already bookmarked
    if (this._bookmarks.some(b => b.path === this.currentPath)) return;
    const label = this.currentPath.split('/').pop() || this.currentPath;
    this._bookmarks.push({ label, path: this.currentPath });
    this._saveBookmarks();
    this._renderBookmarks();
  }



  // ── Settings ──
  _showSettings(e, btnEl) {
    document.querySelectorAll('.file-settings-popover').forEach(p => p.remove());
    const pop = document.createElement('div'); pop.className = 'file-settings-popover';

    // Hidden files
    const hiddenRow = this._settingsCheckbox('Show hidden files', this._showHidden, (v) => {
      this._showHidden = v; this._persistSettings(); this._renderItems();
    });

    // Mixed sort
    const mixedRow = this._settingsCheckbox('Mixed sort (no dirs-first)', this._mixedSort, (v) => {
      this._mixedSort = v; this._persistSettings(); this._renderItems();
    });

    // Default sort
    const sortRow = document.createElement('div'); sortRow.className = 'file-settings-row';
    const sortLabel = document.createElement('span'); sortLabel.textContent = 'Default sort';
    const sortSelect = document.createElement('select'); sortSelect.className = 'file-settings-select';
    for (const opt of ['name', 'size', 'modified', 'created', 'type']) {
      const o = document.createElement('option'); o.value = opt; o.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
      if (this._sortBy === opt) o.selected = true;
      sortSelect.appendChild(o);
    }
    sortSelect.onchange = () => { this._sortBy = sortSelect.value; this._persistSettings(); this._renderSortHeader(); this._renderItems(); };
    sortRow.append(sortLabel, sortSelect);

    // Sort direction
    const dirRow = document.createElement('div'); dirRow.className = 'file-settings-row';
    const dirLabel = document.createElement('span'); dirLabel.textContent = 'Sort direction';
    const dirBtn = document.createElement('button'); dirBtn.className = 'file-tool-btn';
    dirBtn.textContent = this._sortAsc ? 'Asc \u25B2' : 'Desc \u25BC';
    dirBtn.onclick = () => { this._sortAsc = !this._sortAsc; dirBtn.textContent = this._sortAsc ? 'Asc \u25B2' : 'Desc \u25BC'; this._persistSettings(); this._renderSortHeader(); this._renderItems(); };
    dirRow.append(dirLabel, dirBtn);

    pop.append(hiddenRow, mixedRow, sortRow, dirRow);
    document.body.appendChild(pop);

    // Position near button
    const rect = btnEl.getBoundingClientRect();
    pop.style.top = (rect.bottom + 4) + 'px';
    pop.style.right = (window.innerWidth - rect.right) + 'px';
    attachPopoverClose(pop, btnEl);
  }

  _settingsCheckbox(label, checked, onChange) {
    const row = document.createElement('div'); row.className = 'file-settings-row';
    const lbl = document.createElement('label'); lbl.className = 'file-settings-label';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = checked;
    cb.onchange = () => onChange(cb.checked);
    const txt = document.createElement('span'); txt.textContent = label;
    lbl.append(cb, txt);
    row.appendChild(lbl);
    return row;
  }

  _persistSettings() {
    _saveSettings({
      showHidden: this._showHidden,
      mixedSort: this._mixedSort,
      defaultSort: this._sortBy,
      defaultSortAsc: this._sortAsc,
    });
  }

  // ── Column configuration ──
  _getVisibleColumns() {
    return ALL_COLUMNS.filter(c => c.alwaysOn || this._columns[c.key]);
  }

  _showColumnMenu(x, y) {
    document.querySelectorAll('.context-menu').forEach(m => m.remove());
    const menu = document.createElement('div'); menu.className = 'context-menu';
    menu.style.left = x + 'px'; menu.style.top = y + 'px';

    for (const col of ALL_COLUMNS) {
      const el = document.createElement('div'); el.className = 'context-menu-item';
      const cb = document.createElement('input'); cb.type = 'checkbox';
      cb.checked = col.alwaysOn || this._columns[col.key];
      cb.disabled = !!col.alwaysOn;
      cb.style.marginRight = '6px';
      const txt = document.createTextNode(col.label);
      el.append(cb, txt);
      el.onclick = (e) => {
        if (col.alwaysOn) return;
        e.stopPropagation();
        this._columns[col.key] = !this._columns[col.key];
        cb.checked = this._columns[col.key];
        _saveColumns(this._columns);
        this._renderSortHeader();
        this._renderItems();
      };
      menu.appendChild(el);
    }
    document.body.appendChild(menu);
    attachPopoverClose(menu);
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
      const maxLen = 40;
      const display = data.path.length > maxLen ? '\u2026' + data.path.slice(-maxLen + 1) : data.path;
      this.app.wm.setTitle(this.winInfo.id, `\uD83D\uDCC1 ${display}`);
      this._renderItems();
    } catch (err) { this.listEl.innerHTML = `<div class="empty-hint" style="color:var(--red)">${err.message}</div>`; }
  }

  _renderSortHeader() {
    this.sortHeader.innerHTML = '';
    const visCols = this._getVisibleColumns();
    for (const col of visCols) {
      const el = document.createElement('span');
      el.className = 'file-sort-col';
      if (col.flex) el.style.flex = col.flex; else el.style.width = col.width;
      const arrow = this._sortBy === col.key ? (this._sortAsc ? ' \u25B2' : ' \u25BC') : '';
      el.textContent = col.label + arrow;
      el.onclick = () => {
        if (this._sortBy === col.key) this._sortAsc = !this._sortAsc;
        else { this._sortBy = col.key; this._sortAsc = col.key === 'name'; }
        this._persistSettings();
        this._renderSortHeader();
        this._renderItems();
      };
      this.sortHeader.appendChild(el);
    }
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
    return new Date(ms).toLocaleDateString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  }

  _renderItems() {
    const sorted = this._getSortedItems();
    this.listEl.innerHTML = '';
    this.listEl.className = 'file-list' + (this._viewMode === 'icon' ? ' icon-view' : '');
    this.sortHeader.style.display = this._viewMode === 'list' ? '' : 'none';

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
      cell.addEventListener('click', () => { this.listEl.querySelectorAll('.file-icon-cell').forEach(c => c.classList.remove('selected')); cell.classList.add('selected'); });
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
      row.addEventListener('click', () => { this.listEl.querySelectorAll('.file-item').forEach(r => r.classList.remove('selected')); row.classList.add('selected'); });
      row.addEventListener('dblclick', () => {
        if (item.isDirectory) this.navigate(fullPath);
        else this.app.openFile(fullPath, item.name);
      });
      return row;
    }
  }

  navigateUp() { this.navigate(this.currentPath.replace(/\/[^/]+\/?$/, '') || '/'); }
  refresh() { this.navigate(this.currentPath); }

  async createFile() { const n = prompt('File name:'); if (n) { await fetch('/api/file/write', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:this.currentPath+'/'+n, content:''}) }); this.refresh(); } }
  async createDir() { const n = prompt('Folder name:'); if (n) { await fetch('/api/mkdir', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:this.currentPath+'/'+n}) }); this.refresh(); } }

  _triggerUpload() { this.uploadInput.click(); }

  async _uploadFiles(files) {
    const fd = new FormData(); fd.append('destDir', this.currentPath);
    for (const f of files) fd.append('files', f);
    try { await fetch('/api/upload', { method: 'POST', body: fd }); this.refresh(); } catch {}
  }

  _showContextMenu(x, y, dataset) {
    document.querySelectorAll('.context-menu').forEach(m => m.remove());
    const menu = document.createElement('div'); menu.className = 'context-menu';
    menu.style.left = x+'px'; menu.style.top = y+'px';
    const fullPath = this.currentPath + '/' + dataset.name;
    const items = [];
    if (dataset.isDir === 'true') {
      const isBookmarked = this._bookmarks.some(b => b.path === fullPath);
      items.push({ label: isBookmarked ? '★ Bookmarked' : '☆ Add to bookmarks', action: () => {
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
      items.push({ label:'Open', action:() => this.app.openFile(fullPath, dataset.name) });
      items.push({ label:'Edit', action:() => this.app.openEditor(fullPath, dataset.name) });
      items.push({ label:'Open as Hex', action:() => this.app.openFile(fullPath, dataset.name, { hex: true }) });
      items.push({ label:'Download', action:() => { window.open(`/api/download?path=${encodeURIComponent(fullPath)}`); } });
    }
    items.push({ label:'Rename', action:() => this._rename(dataset.name) });
    items.push({ label:'Delete', action:() => this._delete(dataset.name, dataset.isDir==='true') });

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

  async _rename(oldName) { const n = prompt('New name:', oldName); if (n && n!==oldName) { await fetch('/api/rename', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({oldPath:this.currentPath+'/'+oldName,newPath:this.currentPath+'/'+n})}); this.refresh(); } }
  async _delete(name, isDir) { if (!confirm(`Delete "${name}"?`)) return; await fetch(`/api/file?path=${encodeURIComponent(this.currentPath+'/'+name)}`,{method:'DELETE'}); this.refresh(); }

  // ── Group by (preserved from existing implementation) ──
  _showGroupByMenu(anchor) {
    document.querySelectorAll('.file-group-menu').forEach(m => m.remove());
    const menu = document.createElement('div'); menu.className = 'file-group-menu';
    const rect = anchor.getBoundingClientRect();
    menu.style.top = (rect.bottom + 2) + 'px'; menu.style.left = rect.left + 'px';

    const options = [
      { id: 'none', label: 'None (flat list)' },
      { id: 'type', label: 'Type (extension)' },
      { id: 'modified', label: 'Modified (date)' },
      { id: 'size', label: 'Size (range)' },
    ];
    for (const opt of options) {
      const row = document.createElement('div'); row.className = 'file-group-menu-item';
      if (this._groupBy === opt.id) row.classList.add('active');
      row.textContent = (this._groupBy === opt.id ? '\u2713 ' : '  ') + opt.label;
      row.onclick = () => {
        this._groupBy = opt.id;
        this._collapsedGroups.clear();
        localStorage.setItem('fileExplorerGroupBy', opt.id);
        this._btnGroup.classList.toggle('active', opt.id !== 'none');
        this._btnGroup.title = 'Group by: ' + opt.id;
        menu.remove();
        this._renderItems();
      };
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    attachPopoverClose(menu, anchor);
  }

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

  _fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const m = { js:'\uD83D\uDCDC',ts:'\uD83D\uDCDC',py:'\uD83D\uDC0D',go:'\uD83D\uDD37',rs:'\uD83E\uDD80',html:'\uD83C\uDF10',css:'\uD83C\uDFA8',json:'{}',md:'\uD83D\uDCDD',txt:'\uD83D\uDCC4',
      pdf:'\uD83D\uDCD5',doc:'\uD83D\uDCD8',docx:'\uD83D\uDCD8',xls:'\uD83D\uDCCA',xlsx:'\uD83D\uDCCA',csv:'\uD83D\uDCCA',
      jpg:'\uD83D\uDDBC',jpeg:'\uD83D\uDDBC',png:'\uD83D\uDDBC',gif:'\uD83D\uDDBC',svg:'\uD83D\uDDBC',webp:'\uD83D\uDDBC',sh:'\u2699',bash:'\u2699',zsh:'\u2699' };
    return m[ext] || '\uD83D\uDCC4';
  }
}

export { FileExplorer };
