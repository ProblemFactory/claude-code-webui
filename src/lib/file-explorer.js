import { formatSize } from './utils.js';

class FileExplorer {
  constructor(winInfo, app) {
    this.winInfo = winInfo; this.app = app; this.currentPath = ''; this.items = [];
    this._showHidden = false;
    this._viewMode = 'list'; // 'list' or 'icon'
    this._sortBy = 'name';   // 'name', 'size', 'modified'
    this._sortAsc = true;

    const el = document.createElement('div'); el.className = 'file-explorer';

    // Toolbar
    const toolbar = document.createElement('div'); toolbar.className = 'file-toolbar';
    const btnUp = this._btn('↑','Go up'); btnUp.onclick = () => this.navigateUp();
    this.pathInput = document.createElement('input'); this.pathInput.className = 'file-path-input';
    this.pathInput.addEventListener('keydown', e => { if (e.key==='Enter') { this._hideAC(); this.navigate(this.pathInput.value); } });
    this._setupPathAutocomplete();
    const btnRefresh = this._btn('↻','Refresh'); btnRefresh.onclick = () => this.refresh();
    const btnHidden = this._btn('⚬','Toggle hidden files'); btnHidden.onclick = () => { this._showHidden = !this._showHidden; btnHidden.classList.toggle('active', this._showHidden); this._renderItems(); };
    const btnListView = this._btn('≡','List view'); btnListView.onclick = () => { this._viewMode = 'list'; this._renderItems(); btnListView.classList.add('active'); btnIconView.classList.remove('active'); };
    btnListView.classList.add('active');
    const btnIconView = this._btn('⊞','Icon view'); btnIconView.onclick = () => { this._viewMode = 'icon'; this._renderItems(); btnIconView.classList.add('active'); btnListView.classList.remove('active'); };
    const btnNewFile = this._btn('+','New file'); btnNewFile.onclick = () => this.createFile();
    const btnNewDir = this._btn('📂','New folder'); btnNewDir.onclick = () => this.createDir();
    const btnUpload = this._btn('⬆','Upload'); btnUpload.onclick = () => this._triggerUpload();
    this._acDropdown = document.createElement('div'); this._acDropdown.className = 'path-autocomplete hidden';
    toolbar.style.position = 'relative';
    toolbar.append(btnUp, this.pathInput, btnRefresh, btnHidden, btnListView, btnIconView, btnNewFile, btnNewDir, btnUpload, this._acDropdown);

    // Sort header (for list view)
    this.sortHeader = document.createElement('div'); this.sortHeader.className = 'file-sort-header';
    this._renderSortHeader();

    this.listEl = document.createElement('div'); this.listEl.className = 'file-list';

    // Upload drop zone
    this.uploadInput = document.createElement('input'); this.uploadInput.type = 'file'; this.uploadInput.multiple = true;
    this.uploadInput.style.display = 'none';
    this.uploadInput.onchange = (e) => this._uploadFiles(e.target.files);

    el.append(toolbar, this.sortHeader, this.listEl, this.uploadInput);
    winInfo.content.appendChild(el);

    // Drag and drop (upload)
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
    el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files.length) this._uploadFiles(e.dataTransfer.files); });

    this.listEl.addEventListener('contextmenu', (e) => {
      e.preventDefault(); const item = e.target.closest('.file-item');
      if (item) this._showContextMenu(e.clientX, e.clientY, item.dataset);
    });

    this._loadHome();
  }

  _btn(text, title) { const b = document.createElement('button'); b.className='file-tool-btn'; b.textContent=text; b.title=title; return b; }

  async _loadHome() { try { const r = await fetch('/api/home'); const d = await r.json(); this.navigate(d.home); } catch { this.navigate('/'); } }

  async navigate(dirPath) {
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(dirPath)}`);
      const data = await res.json(); if (data.error) throw new Error(data.error);
      this.currentPath = data.path; this.pathInput.value = data.path; this.items = data.items;
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

    // Dirs first, then sort within each group
    const dirs = items.filter(i => i.isDirectory);
    const files = items.filter(i => !i.isDirectory);
    const sortFn = (a, b) => {
      let cmp = 0;
      if (this._sortBy === 'name') cmp = a.name.localeCompare(b.name);
      else if (this._sortBy === 'size') cmp = (a.size || 0) - (b.size || 0);
      else if (this._sortBy === 'modified') cmp = (a.modified || 0) - (b.modified || 0);
      return this._sortAsc ? cmp : -cmp;
    };
    dirs.sort(sortFn);
    files.sort(sortFn);
    return [...dirs, ...files];
  }

  _renderItems() {
    const sorted = this._getSortedItems();
    this.listEl.innerHTML = '';
    this.listEl.className = 'file-list' + (this._viewMode === 'icon' ? ' icon-view' : '');
    this.sortHeader.style.display = this._viewMode === 'list' ? '' : 'none';

    for (const item of sorted) {
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
    const items = [];
    if (dataset.isDir === 'true') {
      items.push({ label:'Open in Terminal', action:() => this.app.createSession({cwd:this.currentPath+'/'+dataset.name}) });
    } else {
      items.push({ label:'Open', action:() => this.app.openFile(this.currentPath+'/'+dataset.name, dataset.name) });
      items.push({ label:'Edit', action:() => this.app.openEditor(this.currentPath+'/'+dataset.name, dataset.name) });
      items.push({ label:'Open as Hex', action:() => this.app.openFile(this.currentPath+'/'+dataset.name, dataset.name, { hex: true }) });
      items.push({ label:'Download', action:() => { window.open(`/api/download?path=${encodeURIComponent(this.currentPath+'/'+dataset.name)}`); } });
    }
    items.push({ label:'Rename', action:() => this._rename(dataset.name) });
    items.push({ label:'Delete', action:() => this._delete(dataset.name, dataset.isDir==='true') });

    for (const item of items) {
      const el = document.createElement('div'); el.className = 'context-menu-item'; el.textContent = item.label;
      el.onclick = () => { menu.remove(); item.action(); }; menu.appendChild(el);
    }
    document.body.appendChild(menu);
    setTimeout(() => { const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); } }; document.addEventListener('mousedown', close); }, 0);
  }

  async _rename(oldName) { const n = prompt('New name:', oldName); if (n && n!==oldName) { await fetch('/api/rename', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({oldPath:this.currentPath+'/'+oldName,newPath:this.currentPath+'/'+n})}); this.refresh(); } }
  async _delete(name, isDir) { if (!confirm(`Delete "${name}"?`)) return; await fetch(`/api/file?path=${encodeURIComponent(this.currentPath+'/'+name)}`,{method:'DELETE'}); this.refresh(); }

  _setupPathAutocomplete() {
    const input = this.pathInput;
    const dropdown = this._acDropdown;
    let timer = null, abortCtrl = null, activeIdx = -1, items = [];

    const hide = () => { dropdown.classList.add('hidden'); dropdown.innerHTML = ''; items = []; activeIdx = -1; };
    this._hideAC = hide;

    const show = (suggestions) => {
      dropdown.innerHTML = ''; items = suggestions; activeIdx = -1;
      if (!suggestions.length) { hide(); return; }
      dropdown.classList.remove('hidden');
      for (let i = 0; i < suggestions.length; i++) {
        const el = document.createElement('div'); el.className = 'autocomplete-item';
        el.textContent = suggestions[i];
        el.onmousedown = (e) => { e.preventDefault(); input.value = suggestions[i] + '/'; hide(); fetchAC(input.value); };
        dropdown.appendChild(el);
      }
    };

    const highlight = (idx) => {
      dropdown.querySelectorAll('.autocomplete-item').forEach((el, i) => el.classList.toggle('active', i === idx));
      activeIdx = idx;
    };

    const fetchAC = (val) => {
      if (abortCtrl) abortCtrl.abort();
      abortCtrl = new AbortController();
      fetch(`/api/dir-complete?path=${encodeURIComponent(val)}`, { signal: abortCtrl.signal })
        .then(r => r.json()).then(d => show(d.suggestions || [])).catch(() => {});
    };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      if (!input.value) { hide(); return; }
      timer = setTimeout(() => fetchAC(input.value), 150);
    });

    input.addEventListener('keydown', (e) => {
      if (dropdown.classList.contains('hidden') || !items.length) {
        if (e.key === 'Tab' && input.value) { e.preventDefault(); fetchAC(input.value); }
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(activeIdx + 1, items.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(activeIdx - 1, 0)); }
      else if (e.key === 'Tab' || e.key === 'Enter') {
        if (activeIdx >= 0) { e.preventDefault(); input.value = items[activeIdx] + '/'; hide(); fetchAC(input.value); }
        else if (e.key === 'Tab' && items.length === 1) { e.preventDefault(); input.value = items[0] + '/'; hide(); fetchAC(input.value); }
      } else if (e.key === 'Escape') { hide(); }
    });

    input.addEventListener('blur', () => setTimeout(hide, 200));
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
