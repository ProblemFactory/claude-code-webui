import { Resizer } from './resizer.js';
import { escHtml, attachPopoverClose } from './utils.js';

class Sidebar {
  constructor(app) {
    this.app = app; this.el = document.getElementById('sidebar');
    this.listEl = document.getElementById('all-sessions-list');
    this.isOpen = false;

    // Resizable sidebar width — handle inside sidebar (position:fixed can't use sibling)
    this._resizer = new Resizer(this.el, 'horizontal', {
      min: 200, max: 500, initial: parseInt(localStorage.getItem('sidebarWidth')) || 260,
      storageKey: 'sidebarWidth', inside: true,
      onResize: (w) => {
        document.getElementById('main-wrapper').style.marginLeft = this.isOpen ? w + 'px' : '0';
        setTimeout(() => { for (const [, s] of this.app.sessions) { if (s.fit) s.fit(); } }, 50);
      },
    });
    this._allSessions = [];
    this._webuiSessions = [];
    this._starredIds = new Set(JSON.parse(localStorage.getItem('starredSessions') || '[]'));
    this._customNames = JSON.parse(localStorage.getItem('sessionCustomNames') || '{}');
    this._sortMode = localStorage.getItem('sessionSort') || 'recent';
    this._filterLive = false;
    this._collapsedFolders = new Set(JSON.parse(localStorage.getItem('collapsedFolders') || '[]'));

    document.getElementById('sidebar-toggle').onclick = () => this.toggle();
    document.getElementById('sidebar-close').onclick = () => this.toggle(false);
    document.getElementById('session-filter').oninput = () => this._render();

    // Sort toggle
    const sortBtn = document.getElementById('sort-toggle');
    this._updateSortBtn(sortBtn);
    sortBtn.onclick = () => {
      this._sortMode = this._sortMode === 'recent' ? 'folder' : 'recent';
      localStorage.setItem('sessionSort', this._sortMode);
      this._updateSortBtn(sortBtn);
      this._render();
    };

    // Status filter dropdown (multi-select: live, running, stopped)
    this._statusFilter = new Set(['live', 'tmux', 'external', 'stopped']); // all enabled by default
    const filterBtn = document.getElementById('live-filter');
    filterBtn.onclick = (e) => { e.stopPropagation(); this._showStatusFilterMenu(filterBtn); };

    this._sessionDigest = '';
    app.ws.onGlobal((msg) => {
      if (msg.type === 'active-sessions') { this._webuiSessions = msg.sessions; this._mergeAndRender(); }
    });
    this._poll();
  }

  toggleStar(sessionId) {
    if (this._starredIds.has(sessionId)) this._starredIds.delete(sessionId);
    else this._starredIds.add(sessionId);
    localStorage.setItem('starredSessions', JSON.stringify([...this._starredIds]));
    this._render();
    this.app.updateTaskbar();
  }

  isStarred(sessionId) { return this._starredIds.has(sessionId); }

  getCustomName(sessionId) { return this._customNames[sessionId] || null; }

  renameSession(sessionId, currentName) {
    const name = prompt('Session name (used as --name on next resume):', this._customNames[sessionId] || currentName || '');
    if (name === null) return; // cancelled
    if (name.trim()) {
      this._customNames[sessionId] = name.trim();
    } else {
      delete this._customNames[sessionId];
    }
    localStorage.setItem('sessionCustomNames', JSON.stringify(this._customNames));
    this._render();
  }

  _updateSortBtn(btn) {
    btn.textContent = this._sortMode === 'recent' ? '⏱' : '📁';
    btn.title = `Sort by: ${this._sortMode === 'recent' ? 'Recent' : 'Folder'}`;
  }

  _showStatusFilterMenu(anchor) {
    document.querySelectorAll('.status-filter-menu').forEach(m => m.remove());
    const menu = document.createElement('div'); menu.className = 'status-filter-menu';
    const rect = anchor.getBoundingClientRect();
    menu.style.top = (rect.bottom + 2) + 'px'; menu.style.left = rect.left + 'px';

    const items = [
      { id: 'live', label: 'Live', color: 'var(--green)' },
      { id: 'tmux', label: 'Tmux', color: 'var(--blue)' },
      { id: 'external', label: 'External', color: 'var(--yellow)' },
      { id: 'stopped', label: 'Stopped', color: 'var(--text-dim)' },
    ];
    for (const item of items) {
      const row = document.createElement('label'); row.className = 'status-filter-item';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = this._statusFilter.has(item.id);
      const dot = document.createElement('span'); dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${item.color};flex-shrink:0`;
      const lbl = document.createElement('span'); lbl.textContent = item.label;
      cb.onchange = () => {
        if (cb.checked) this._statusFilter.add(item.id); else this._statusFilter.delete(item.id);
        this._updateFilterBtn(anchor);
        this._render();
      };
      row.append(cb, dot, lbl);
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    attachPopoverClose(menu, anchor);
  }

  _updateFilterBtn(btn) {
    const allOn = this._statusFilter.size === 4;
    btn.style.color = allOn ? '' : 'var(--accent-hover)';
    btn.title = allOn ? 'Filter by status' : `Showing: ${[...this._statusFilter].join(', ')}`;
  }

  toggle(force) {
    this.isOpen = force !== undefined ? force : !this.isOpen;
    this.el.classList.toggle('open', this.isOpen);
    const wrapper = document.getElementById('main-wrapper');
    wrapper.classList.toggle('sidebar-open', this.isOpen);
    wrapper.style.marginLeft = this.isOpen ? this.el.offsetWidth + 'px' : '0';
    setTimeout(() => { for (const [, s] of this.app.sessions) { if (s.fit) s.fit(); } }, 250);
  }

  async _poll() {
    try {
      const res = await fetch('/api/sessions'); const data = await res.json();
      this._systemSessions = data.sessions || [];
      this._mergeAndRender();
    } catch {}
    setTimeout(() => this._poll(), 5000);
  }

  _merge() {
    const system = this._systemSessions || [];
    const webui = this._webuiSessions || [];
    const matchedWebuiIds = new Set();

    const unified = system.map(s => {
      const wm = webui.find(ws => ws.claudeSessionId === s.sessionId);
      if (wm) matchedWebuiIds.add(wm.id);
      // Only upgrade to 'live' for dtach-managed sessions (not tmux/external — those keep their status)
      const status = (wm && s.status === 'stopped') ? 'live' : (wm && s.status !== 'tmux' && s.status !== 'external') ? 'live' : s.status;
      return { ...s, status, webuiId: wm?.id || null, webuiName: wm?.name || null };
    });

    for (const ws of webui) {
      if (!matchedWebuiIds.has(ws.id)) {
        unified.unshift({ sessionId: ws.claudeSessionId || ws.id, cwd: ws.cwd, startedAt: ws.createdAt, status: 'live', webuiId: ws.id, webuiName: ws.name, name: ws.name || '' });
      }
    }

    this._allSessions = unified;
  }

  _mergeAndRender() {
    this._merge();
    const digest = JSON.stringify(this._allSessions.map(s => s.sessionId + ':' + s.status));
    if (digest === this._sessionDigest) return;
    this._sessionDigest = digest;
    this._render();
  }

  _render() {
    const f = (document.getElementById('session-filter')?.value || '').toLowerCase();
    let sessions = this._allSessions;

    // Text filter
    if (f) sessions = sessions.filter(s => (s.cwd||'').toLowerCase().includes(f) || (s.sessionId||'').toLowerCase().includes(f) || (s.name||'').toLowerCase().includes(f) || (s.webuiName||'').toLowerCase().includes(f));

    // Status filter
    if (this._statusFilter.size < 4) {
      sessions = sessions.filter(s => this._statusFilter.has(s.status));
    }

    this.listEl.innerHTML = '';

    // "New Session" card at the top
    const newCard = document.createElement('div'); newCard.className = 'session-item-card new-session-card';
    newCard.innerHTML = '<div class="session-card-name" style="color:var(--accent-hover)">+ New Session</div>';
    newCard.onclick = () => this.app.showNewSessionDialog();
    this.listEl.appendChild(newCard);

    if (!sessions.length) { this.listEl.insertAdjacentHTML('beforeend', '<div class="empty-hint">No sessions</div>'); return; }

    this._renderGrouped(sessions);
  }

  _renderGrouped(sessions) {
    const groups = new Map();
    for (const s of sessions) {
      const key = s.cwd || '/unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    let groupEntries = [...groups.entries()];
    if (this._sortMode === 'folder') {
      groupEntries.sort((a, b) => a[0].localeCompare(b[0]));
    } else {
      groupEntries.sort((a, b) => {
        // Groups with starred sessions first
        const aStarred = a[1].some(s => this._starredIds.has(s.sessionId)) ? 1 : 0;
        const bStarred = b[1].some(s => this._starredIds.has(s.sessionId)) ? 1 : 0;
        if (aStarred !== bStarred) return bStarred - aStarred;
        const aMax = Math.max(...a[1].map(s => s.startedAt || 0));
        const bMax = Math.max(...b[1].map(s => s.startedAt || 0));
        return bMax - aMax;
      });
    }

    for (const [cwd, items] of groupEntries) {
      const group = document.createElement('div'); group.className = 'folder-group';
      if (this._collapsedFolders.has(cwd)) group.classList.add('collapsed');

      const cwdShort = cwd.replace(/^\/home\/[^/]+/, '~');
      const hasLive = items.some(s => s.status === 'live' || s.status === 'tmux');

      const header = document.createElement('div'); header.className = 'folder-header';
      header.innerHTML = `<span class="folder-chevron">▼</span><span class="folder-path">${cwdShort}</span><span class="folder-count">${items.length}</span>`;
      if (hasLive) {
        const dot = document.createElement('span');
        dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0';
        header.insertBefore(dot, header.children[2]);
      }

      // "+" button to create new session in this folder
      const addBtn = document.createElement('button'); addBtn.className = 'folder-add-btn';
      addBtn.textContent = '+'; addBtn.title = 'New session in ' + cwdShort;
      addBtn.onclick = (e) => { e.stopPropagation(); this.app.createSession({ cwd }); };
      header.appendChild(addBtn);

      header.onclick = (e) => {
        if (e.target.closest('.folder-add-btn')) return;
        group.classList.toggle('collapsed');
        if (group.classList.contains('collapsed')) this._collapsedFolders.add(cwd);
        else this._collapsedFolders.delete(cwd);
        localStorage.setItem('collapsedFolders', JSON.stringify([...this._collapsedFolders]));
      };

      const sessionsDiv = document.createElement('div'); sessionsDiv.className = 'folder-sessions';
      // Starred first, then by time
      items.sort((a, b) => {
        const as = this._starredIds.has(a.sessionId) ? 1 : 0;
        const bs = this._starredIds.has(b.sessionId) ? 1 : 0;
        if (as !== bs) return bs - as;
        return (b.startedAt||0) - (a.startedAt||0);
      });
      for (const s of items) { sessionsDiv.appendChild(this._renderSessionCard(s)); }

      group.append(header, sessionsDiv);
      this.listEl.appendChild(group);
    }
  }

  _renderSessionCard(s) {
    const card = document.createElement('div'); card.className = 'session-item-card';
    const date = new Date(s.startedAt);
    const customName = this._customNames[s.sessionId];
    const originalName = s.name || s.webuiName || s.sessionId.substring(0, 12) + '...';
    const displayName = customName || originalName;
    const idShort = s.sessionId.substring(0, 12);

    const badgeMap = {
      live:     { cls: 'badge-live', text: 'LIVE' },
      tmux:     { cls: 'badge-tmux', text: 'TMUX' },
      external: { cls: 'badge-external', text: 'EXTERNAL' },
      stopped:  { cls: 'badge-stopped', text: 'STOPPED' },
    };
    const badge = badgeMap[s.status] || badgeMap.stopped;

    const starred = this._starredIds.has(s.sessionId);
    card.innerHTML = `
      <div class="session-card-name">${escHtml(displayName)}</div>
      <div class="session-card-path">${idShort}...</div>
      <div class="session-card-meta">
        <span class="session-card-time">${date.toLocaleDateString()} ${date.toLocaleTimeString()}</span>
        <span class="session-card-badge ${badge.cls}">${badge.text}</span>
      </div>`;
    const starBtn = document.createElement('button');
    starBtn.className = 'session-star-btn' + (starred ? ' starred' : '');
    starBtn.textContent = starred ? '★' : '☆';
    starBtn.title = starred ? 'Unstar' : 'Star';
    starBtn.onclick = (e) => { e.stopPropagation(); this.toggleStar(s.sessionId); };
    card.prepend(starBtn);

    // Double-click name to rename (sets --name for next resume)
    const nameEl = card.querySelector('.session-card-name');
    if (nameEl) {
      if (customName) nameEl.title = `Custom name (--name on resume). Original: ${originalName}`;
      nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); this.renameSession(s.sessionId, originalName); });
    }

    if (s.status === 'live' && s.webuiId) {
      card.onclick = () => this.app.attachSession(s.webuiId, s.webuiName || displayName, s.cwd);
    } else if (s.status === 'tmux') {
      card.onclick = () => this.app.attachTmuxSession(s.tmuxTarget, displayName, s.cwd);
      card.title = 'Running in tmux — click to view (closing won\'t kill it)';
    } else if (s.status === 'external') {
      card.style.opacity = '0.7'; card.style.cursor = 'default';
      card.title = 'Running in unsupported terminal (PID ' + (s.pid || '?') + ')';
    } else if (s.status === 'stopped') {
      card.onclick = () => this.app.resumeSession(s.sessionId, s.cwd, customName || s.name);
    }
    return card;
  }

}

export { Sidebar };
