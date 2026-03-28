import { formatSize, attachPopoverClose } from './utils.js';
import { setupDirAutocomplete } from './autocomplete.js';

class FileExplorer {
  constructor(winInfo, app, startPath) {
    this.winInfo = winInfo; this.app = app; this.currentPath = ''; this.items = [];
    this._startPath = startPath || null;
    this._showHidden = false;
    this._viewMode = 'list'; // 'list' or 'icon'
    this._sortBy = 'modified';   // 'name', 'size', 'modified'
    this._sortAsc = false;
    this._renderLimit = 100; // initial batch size for large folders

    // Bookmarks
    const defaultBookmarks = [
      { label: 'Downloads', path: '~/Downloads' },
      { label: 'Documents', path: '~/Documents' },
      { label: 'claude-ops', path: '~/Documents/claude-ops' },
    ];
    this._bookmarks = JSON.parse(localStorage.getItem('fileExplorerBookmarks') || 'null') || defaultBookmarks;
    this._homePath = null;
    fetch('/api/home').then(r => r.json()).then(d => { this._homePath = d.home; }).catch(() => {});

    const el = document.createElement('div'); el.className = 'file-explorer';

    // Toolbar
    const toolbar = document.createElement('div'); toolbar.className = 'file-toolbar';
    const btnUp = this._btn('↑','Go up'); btnUp.onclick = () => this.navigateUp();
    this.pathInput = document.createElement('input'); this.pathInput.className = 'file-path-input';
    this.pathInput.addEventListener('keydown', e => { if (e.key==='Enter') { if (this._hideAC) this._hideAC(); this.navigate(this.pathInput.value); } });
    this._setupPathAutocomplete();
    const btnRefresh = this._btn('↻','Refresh'); btnRefresh.onclick = () => this.refresh();
    const btnHidden = this._btn('⚬','Toggle hidden files'); btnHidden.onclick = () => { this._showHidden = !this._showHidden; btnHidden.classList.toggle('active', this._showHidden); this._renderItems(); };
    const btnListView = this._btn('≡','List view'); btnListView.onclick = () => { this._viewMode = 'list'; this._renderItems(); btnListView.classList.add('active'); btnIconView.classList.remove('active'); };
    btnListView.classList.add('active');
    const btnIconView = this._btn('⊞','Icon view'); btnIconView.onclick = () => { this._viewMode = 'icon'; this._renderItems(); btnIconView.classList.add('active'); btnListView.classList.remove('active'); };
    const btnNewFile = this._btn('+','New file'); btnNewFile.onclick = () => this.createFile();
    const btnNewDir = this._btn('📂','New folder'); btnNewDir.onclick = () => this.createDir();
    const btnUpload = this._btn('⬆','Upload'); btnUpload.onclick = () => this._triggerUpload();
    const btnBookmarks = this._btn('★','Bookmarks'); btnBookmarks.onclick = () => {
      this._bookmarksVisible = !this._bookmarksVisible;
      this.bookmarkPanel.classList.toggle('hidden', !this._bookmarksVisible);
      btnBookmarks.classList.toggle('active', this._bookmarksVisible);
    };
    this._bookmarksVisible = true;
    btnBookmarks.classList.add('active');
    this._acDropdown = document.createElement('div'); this._acDropdown.className = 'path-autocomplete hidden';
    toolbar.style.position = 'relative';
    toolbar.append(btnUp, this.pathInput, btnRefresh, btnHidden, btnListView, btnIconView, btnNewFile, btnNewDir, btnUpload, btnBookmarks, this._acDropdown);

    // Bookmark panel (left sidebar)
    this.bookmarkPanel = document.createElement('div'); this.bookmarkPanel.className = 'file-bookmark-panel';
    this._renderBookmarks();

    // Sort header (for list view)
    this.sortHeader = document.createElement('div'); this.sortHeader.className = 'file-sort-header';
    this._renderSortHeader();

    this.listEl = document.createElement('div'); this.listEl.className = 'file-list';

    // Upload drop zone
    this.uploadInput = document.createElement('input'); this.uploadInput.type = 'file'; this.uploadInput.multiple = true;
    this.uploadInput.style.display = 'none';
    this.uploadInput.onchange = (e) => this._uploadFiles(e.target.files);

    // Layout: toolbar on top, then body = [bookmarkPanel | mainArea]
    const mainArea = document.createElement('div'); mainArea.className = 'file-explorer-main';
    mainArea.append(this.sortHeader, this.listEl);
    const bodyArea = document.createElement('div'); bodyArea.className = 'file-explorer-body';
    bodyArea.append(this.bookmarkPanel, mainArea);
    el.append(toolbar, bodyArea, this.uploadInput);
    winInfo.content.appendChild(el);

    // Drag and drop (upload)
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
    el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files.length) this._uploadFiles(e.dataTransfer.files); });

    this.listEl.addEventListener('contextmenu', (e) => {
      e.preventDefault(); const item = e.target.closest('.file-item');
      if (item) this._showContextMenu(e.clientX, e.clientY, item.dataset);
    });

    if (this._startPath) this.navigate(this._startPath);
    else this._loadHome();
  }

  _btn(text, title) { const b = document.createElement('button'); b.className='file-tool-btn'; b.textContent=text; b.title=title; return b; }

  async _loadHome() { try { const r = await fetch('/api/home'); const d = await r.json(); this.navigate(d.home); } catch { this.navigate('/'); } }

  async navigate(dirPath) {
    try {
      this._renderLimit = 100; // reset batch on navigation
      const res = await fetch(`/api/files?path=${encodeURIComponent(dirPath)}`);
      const data = await res.json(); if (data.error) throw new Error(data.error);
      this.currentPath = data.path; this.pathInput.value = data.path; this.items = data.items;
      this.winInfo._explorerPath = data.path; // for layout persistence
      const maxLen = 40;
      const display = data.path.length > maxLen ? '…' + data.path.slice(-maxLen + 1) : data.path;
      this.app.wm.setTitle(this.winInfo.id, `📁 ${display}`);
      this._renderItems();
    } catch (err) { this.listEl.innerHTML = `<div class="empty-hint" style="color:var(--red)">${err.message}</div>`; }
  }

  _renderSortHeader() {
    this.sortHeader.innerHTML = '';
    const cols = [
      { key: 'name', label: 'Name', flex: 1 },
      { key: 'size', label: 'Size', width: '80px' },
      { key: 'modified', label: 'Modified', width: '140px' },
    ];
    for (const col of cols) {
      const el = document.createElement('span');
      el.className = 'file-sort-col';
      if (col.flex) el.style.flex = col.flex; else el.style.width = col.width;
      const arrow = this._sortBy === col.key ? (this._sortAsc ? ' ▲' : ' ▼') : '';
      el.textContent = col.label + arrow;
      el.onclick = () => {
        if (this._sortBy === col.key) this._sortAsc = !this._sortAsc;
        else { this._sortBy = col.key; this._sortAsc = col.key === 'name'; }
        this._renderSortHeader();
        this._renderItems();
      };
      this.sortHeader.appendChild(el);
    }
  }

  _getSortedItems() {
    let items = [...this.items];
    if (!this._showHidden) items = items.filter(i => !i.name.startsWith('.'));

    const sortFn = (a, b) => {
      let cmp = 0;
      if (this._sortBy === 'name') cmp = a.name.localeCompare(b.name);
      else if (this._sortBy === 'size') cmp = (a.size || 0) - (b.size || 0);
      else if (this._sortBy === 'modified') cmp = (a.modified || 0) - (b.modified || 0);
      return this._sortAsc ? cmp : -cmp;
    };

    // When sorting by modified time, flat sort without grouping
    if (this._sortBy === 'modified') {
      items.sort(sortFn);
      return items;
    }

    // For name/size: dirs first, then sort within each group
    const dirs = items.filter(i => i.isDirectory);
    const files = items.filter(i => !i.isDirectory);
    dirs.sort(sortFn);
    files.sort(sortFn);
    return [...dirs, ...files];
  }

  _renderItems() {
    const sorted = this._getSortedItems();
    this.listEl.innerHTML = '';
    this.listEl.className = 'file-list' + (this._viewMode === 'icon' ? ' icon-view' : '');
    this.sortHeader.style.display = this._viewMode === 'list' ? '' : 'none';

    const visible = sorted.slice(0, this._renderLimit);

    for (const item of visible) {
      const fullPath = this.currentPath + '/' + item.name;

      if (this._viewMode === 'icon') {
        const cell = document.createElement('div'); cell.className = 'file-icon-cell';
        cell.dataset.name = item.name; cell.dataset.isDir = item.isDirectory;
        const icon = document.createElement('div'); icon.className = 'file-icon-large';
        icon.textContent = item.isDirectory ? '📁' : this._fileIcon(item.name);
        const label = document.createElement('div'); label.className = 'file-icon-label'; label.textContent = item.name;
        cell.append(icon, label);
        cell.draggable = true;
        cell.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', fullPath); e.dataTransfer.setData('application/x-file-path', fullPath); });
        cell.addEventListener('click', () => { this.listEl.querySelectorAll('.file-icon-cell').forEach(c => c.classList.remove('selected')); cell.classList.add('selected'); });
        cell.addEventListener('dblclick', () => {
          if (item.isDirectory) this.navigate(fullPath);
          else this.app.openFile(fullPath, item.name);
        });
        this.listEl.appendChild(cell);
      } else {
        const row = document.createElement('div'); row.className = 'file-item';
        row.dataset.name = item.name; row.dataset.isDir = item.isDirectory;
        const iconEl = document.createElement('span'); iconEl.className = 'file-icon'; iconEl.textContent = item.isDirectory ? '📁' : this._fileIcon(item.name);
        const nameEl = document.createElement('span'); nameEl.className = 'file-name'; nameEl.textContent = item.name;
        const sizeEl = document.createElement('span'); sizeEl.className = 'file-meta file-size'; sizeEl.textContent = item.isDirectory ? '' : formatSize(item.size);
        const modEl = document.createElement('span'); modEl.className = 'file-meta file-modified';
        modEl.textContent = item.modified ? new Date(item.modified).toLocaleDateString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
        row.append(iconEl, nameEl, sizeEl, modEl);
        row.draggable = true;
        row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', fullPath); e.dataTransfer.setData('application/x-file-path', fullPath); });
        row.addEventListener('click', () => { this.listEl.querySelectorAll('.file-item').forEach(r => r.classList.remove('selected')); row.classList.add('selected'); });
        row.addEventListener('dblclick', () => {
          if (item.isDirectory) this.navigate(fullPath);
          else this.app.openFile(fullPath, item.name);
        });
        this.listEl.appendChild(row);
      }
    }

    // "Load more" button when there are remaining items
    const remaining = sorted.length - this._renderLimit;
    if (remaining > 0) {
      const loadMoreBtn = document.createElement('div'); loadMoreBtn.className = 'file-load-more';
      loadMoreBtn.textContent = `Load more (${remaining} remaining)`;
      loadMoreBtn.onclick = () => { this._renderLimit += 100; this._renderItems(); };
      this.listEl.appendChild(loadMoreBtn);
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
      items.push({ label: 'Sessions', submenu: () => {
        const sub = [];
        sub.push({ label: '+ New session', action: () => this.app.createSession({ cwd: fullPath }) });
        const sessionsHere = (this.app.sidebar?._allSessions || []).filter(s => s.cwd === fullPath);
        for (const s of sessionsHere) {
          const customName = this.app.sidebar?.getCustomName(s.sessionId);
          const dispName = customName || s.name || s.sessionId.substring(0, 12) + '...';
          const badge = s.status === 'live' ? '● ' : s.status === 'tmux' ? '◆ ' : '';
          sub.push({ label: `${badge}${dispName}`, action: () => {
            if (s.status === 'stopped') this.app.resumeSession(s.sessionId, s.cwd, customName || s.name);
            else if (s.status === 'live' && s.webuiId) this.app.attachSession(s.webuiId, s.webuiName || dispName, s.cwd);
            else if (s.status === 'tmux') this.app.attachTmuxSession(s.tmuxTarget, dispName, s.cwd);
          }});
        }
        return sub;
      }});
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
          // Remove any existing submenu
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

  _setupPathAutocomplete() {
    const ac = setupDirAutocomplete(this.pathInput, this._acDropdown, {
      onNavigate: (path) => this.navigate(path),
    });
    this._hideAC = ac.hide;
  }

  _renderBookmarks() {
    this.bookmarkPanel.innerHTML = '';
    const header = document.createElement('div'); header.className = 'file-bookmark-header';
    header.textContent = 'Bookmarks';
    const editBtn = this._btn('✎', 'Edit bookmarks');
    editBtn.onclick = () => this._showBookmarkEditor();
    header.appendChild(editBtn);
    this.bookmarkPanel.appendChild(header);
    for (const bm of this._bookmarks) {
      const item = document.createElement('div'); item.className = 'file-bookmark-item';
      item.textContent = bm.label; item.title = bm.path;
      item.onclick = () => {
        const resolved = bm.path.replace(/^~/, this._homePath || '');
        this.navigate(resolved);
      };
      this.bookmarkPanel.appendChild(item);
    }
  }

  _saveBookmarks() {
    localStorage.setItem('fileExplorerBookmarks', JSON.stringify(this._bookmarks));
    this._renderBookmarks();
  }

  _showBookmarkEditor() {
    // Overlay
    const overlay = document.createElement('div'); overlay.className = 'bookmark-editor-overlay';
    const panel = document.createElement('div'); panel.className = 'bookmark-editor-panel';
    const title = document.createElement('div'); title.className = 'bookmark-editor-title'; title.textContent = 'Edit Bookmarks';
    const list = document.createElement('div'); list.className = 'bookmark-editor-list';
    panel.append(title, list);

    const renderRows = () => {
      list.innerHTML = '';
      this._bookmarks.forEach((bm, i) => {
        const row = document.createElement('div'); row.className = 'bookmark-editor-row';
        const labelInput = document.createElement('input'); labelInput.className = 'bookmark-editor-input bookmark-label';
        labelInput.value = bm.label; labelInput.placeholder = 'Label';
        labelInput.onchange = () => { bm.label = labelInput.value.trim(); };
        const pathInput = document.createElement('input'); pathInput.className = 'bookmark-editor-input bookmark-path';
        pathInput.value = bm.path; pathInput.placeholder = 'Path (supports ~)';
        pathInput.onchange = () => { bm.path = pathInput.value.trim(); };
        const delBtn = this._btn('✕', 'Remove'); delBtn.className = 'bookmark-editor-del';
        delBtn.onclick = () => { this._bookmarks.splice(i, 1); renderRows(); };
        row.append(labelInput, pathInput, delBtn);
        list.appendChild(row);
      });
    };
    renderRows();

    const footer = document.createElement('div'); footer.className = 'bookmark-editor-footer';
    const addBtn = document.createElement('button'); addBtn.className = 'bookmark-editor-btn'; addBtn.textContent = '+ Add';
    addBtn.onclick = () => { this._bookmarks.push({ label: '', path: '' }); renderRows(); list.lastChild?.querySelector('.bookmark-label')?.focus(); };
    const saveBtn = document.createElement('button'); saveBtn.className = 'bookmark-editor-btn bookmark-editor-save'; saveBtn.textContent = 'Save';
    saveBtn.onclick = () => { this._bookmarks = this._bookmarks.filter(b => b.label && b.path); this._saveBookmarks(); overlay.remove(); };
    const cancelBtn = document.createElement('button'); cancelBtn.className = 'bookmark-editor-btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => overlay.remove();
    footer.append(addBtn, cancelBtn, saveBtn);
    panel.appendChild(footer);

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  _fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const m = { js:'📜',ts:'📜',py:'🐍',go:'🔷',rs:'🦀',html:'🌐',css:'🎨',json:'{}',md:'📝',txt:'📄',
      pdf:'📕',doc:'📘',docx:'📘',xls:'📊',xlsx:'📊',csv:'📊',
      jpg:'🖼',jpeg:'🖼',png:'🖼',gif:'🖼',svg:'🖼',webp:'🖼',sh:'⚙',bash:'⚙',zsh:'⚙' };
    return m[ext] || '📄';
  }
}

export { FileExplorer };
