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

    // Load from localStorage as initial cache/fallback
    this._starredIds = new Set(JSON.parse(localStorage.getItem('starredSessions') || '[]'));
    this._archivedIds = new Set(JSON.parse(localStorage.getItem('archivedSessions') || '[]'));
    this._customNames = JSON.parse(localStorage.getItem('sessionCustomNames') || '{}');
    this._sessionGroups = JSON.parse(localStorage.getItem('sessionGroups') || '{}'); // { groupName: [sessionId, ...] }

    this._sortMode = localStorage.getItem('sessionSort') || 'recent';
    this._filterLive = false;
    this._collapsedFolders = new Set(JSON.parse(localStorage.getItem('collapsedFolders') || '[]'));
    this._expandedCardId = null; // only one card expanded at a time

    // Tab state: 'folders' or 'groups'
    this._activeTab = 'folders';

    // Fetch server state (source of truth)
    this._fetchUserState();

    // Listen for user-state-updated WebSocket messages from other clients
    app.ws.onGlobal((msg) => {
      if (msg.type === 'user-state-updated' && msg.state) {
        this._applyServerState(msg.state);
        this._render();
        this.app.updateTaskbar();
      }
    });

    document.getElementById('sidebar-toggle').onclick = () => this.toggle();
    document.getElementById('sidebar-close').onclick = () => this.toggle(false);
    document.getElementById('session-filter').oninput = () => this._render();

    // Build tab bar
    this._buildTabBar();

    // Sort toggle
    const sortBtn = document.getElementById('sort-toggle');
    this._updateSortBtn(sortBtn);
    sortBtn.onclick = () => {
      this._sortMode = this._sortMode === 'recent' ? 'folder' : 'recent';
      localStorage.setItem('sessionSort', this._sortMode);
      this._updateSortBtn(sortBtn);
      this._render();
    };

    // Status filter dropdown (multi-select: live, running, stopped, archived)
    this._statusFilter = new Set(['live', 'tmux', 'external', 'stopped']); // all except archived by default
    const filterBtn = document.getElementById('live-filter');
    filterBtn.onclick = (e) => { e.stopPropagation(); this._showStatusFilterMenu(filterBtn); };

    this._sessionDigest = '';
    app.ws.onGlobal((msg) => {
      if (msg.type === 'active-sessions') { this._webuiSessions = msg.sessions; this._mergeAndRender(); }
    });
    this._poll();
  }

  // ── Server State Sync ──

  async _fetchUserState() {
    try {
      const res = await fetch('/api/user-state');
      if (res.ok) {
        const state = await res.json();
        this._applyServerState(state);
        this._render();
        this.app.updateTaskbar();
      }
    } catch {
      // Server unavailable — use localStorage cache
    }
  }

  _applyServerState(state) {
    if (state.starredSessions) {
      this._starredIds = new Set(state.starredSessions);
      localStorage.setItem('starredSessions', JSON.stringify(state.starredSessions));
    }
    if (state.archivedSessions) {
      this._archivedIds = new Set(state.archivedSessions);
      localStorage.setItem('archivedSessions', JSON.stringify(state.archivedSessions));
    }
    if (state.customNames) {
      this._customNames = { ...state.customNames };
      localStorage.setItem('sessionCustomNames', JSON.stringify(state.customNames));
    }
    if (state.sessionGroups) {
      this._sessionGroups = { ...state.sessionGroups };
      localStorage.setItem('sessionGroups', JSON.stringify(state.sessionGroups));
    }
  }

  async _pushUserState() {
    const state = {
      starredSessions: [...this._starredIds],
      archivedSessions: [...this._archivedIds],
      customNames: this._customNames,
      sessionGroups: this._sessionGroups,
    };
    // Write localStorage cache
    localStorage.setItem('starredSessions', JSON.stringify(state.starredSessions));
    localStorage.setItem('archivedSessions', JSON.stringify(state.archivedSessions));
    localStorage.setItem('sessionCustomNames', JSON.stringify(state.customNames));
    localStorage.setItem('sessionGroups', JSON.stringify(state.sessionGroups));
    // Push to server (broadcasts to other clients)
    try {
      await fetch('/api/user-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
    } catch {
      // Server unavailable — localStorage cache is still updated
    }
  }

  // ── Tab Bar ──

  _buildTabBar() {
    const section = this.listEl.parentElement; // the sidebar-section div containing the list
    const tabBar = document.createElement('div');
    tabBar.className = 'sidebar-tabs';

    const foldersTab = document.createElement('button');
    foldersTab.className = 'sidebar-tab active';
    foldersTab.textContent = 'Folders';
    foldersTab.dataset.tab = 'folders';
    foldersTab.onclick = () => { this._activeTab = 'folders'; this._updateTabs(); this._render(); };

    const groupsTab = document.createElement('button');
    groupsTab.className = 'sidebar-tab';
    groupsTab.textContent = 'Groups';
    groupsTab.dataset.tab = 'groups';
    groupsTab.onclick = () => { this._activeTab = 'groups'; this._updateTabs(); this._render(); };

    tabBar.append(foldersTab, groupsTab);
    // Insert tab bar before the filter row (first child of section)
    section.insertBefore(tabBar, section.firstChild);
  }

  _updateTabs() {
    const tabs = this.el.querySelectorAll('.sidebar-tab');
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === this._activeTab));
  }

  // ── Star / Archive / Rename ──

  // Unified sort: starred first, then by time (desc)
  _sortSessions(arr) {
    arr.sort((a, b) => {
      const as = this._starredIds.has(a.sessionId) ? 1 : 0;
      const bs = this._starredIds.has(b.sessionId) ? 1 : 0;
      if (as !== bs) return bs - as;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });
  }

  toggleStar(sessionId) {
    if (this._starredIds.has(sessionId)) this._starredIds.delete(sessionId);
    else this._starredIds.add(sessionId);
    this._pushUserState();
    this._render();
    this.app.updateTaskbar();
  }

  isStarred(sessionId) { return this._starredIds.has(sessionId); }

  toggleArchive(sessionId) {
    if (this._archivedIds.has(sessionId)) this._archivedIds.delete(sessionId);
    else this._archivedIds.add(sessionId);
    this._pushUserState();
    this._render();
    this.app.updateTaskbar();
  }

  isArchived(sessionId) { return this._archivedIds.has(sessionId); }

  getCustomName(sessionId) { return this._customNames[sessionId] || null; }

  renameSession(sessionId, currentName) {
    const name = prompt('Session name (used as --name on next resume):', this._customNames[sessionId] || currentName || '');
    if (name === null) return; // cancelled
    if (name.trim()) {
      this._customNames[sessionId] = name.trim();
    } else {
      delete this._customNames[sessionId];
    }
    this._pushUserState();
    this._render();
    // Sync renamed session to any open window
    const newName = name.trim() || currentName || sessionId.substring(0, 12) + '...';
    this.app.syncSessionName(sessionId, newName);
  }

  // ── Session Groups ──

  _getGroupNames() {
    return Object.keys(this._sessionGroups).sort((a, b) => a.localeCompare(b));
  }

  _getSessionGroups(sessionId) {
    const groups = [];
    for (const [name, ids] of Object.entries(this._sessionGroups)) {
      if (ids.includes(sessionId)) groups.push(name);
    }
    return groups;
  }

  _addSessionToGroup(sessionId, groupName) {
    if (!this._sessionGroups[groupName]) this._sessionGroups[groupName] = [];
    if (!this._sessionGroups[groupName].includes(sessionId)) {
      this._sessionGroups[groupName].push(sessionId);
    }
    this._pushUserState();
    this._render();
  }

  _removeSessionFromGroup(sessionId, groupName) {
    if (!this._sessionGroups[groupName]) return;
    this._sessionGroups[groupName] = this._sessionGroups[groupName].filter(id => id !== sessionId);
    if (this._sessionGroups[groupName].length === 0) {
      delete this._sessionGroups[groupName];
    }
    this._pushUserState();
    this._render();
  }

  _createGroup(name) {
    if (!name || this._sessionGroups[name]) return;
    this._sessionGroups[name] = [];
    this._pushUserState();
    this._render();
  }

  _deleteGroup(name) {
    delete this._sessionGroups[name];
    this._pushUserState();
    this._render();
  }

  // ── Highlight / Sort / Filter ──

  highlightSession(sessionId) {
    this.listEl.querySelectorAll('.session-item-card').forEach(c => c.classList.remove('highlighted'));
    if (!sessionId) return;
    const cards = this.listEl.querySelectorAll('.session-item-card');
    for (const card of cards) {
      if (card._sessionId === sessionId) {
        card.classList.add('highlighted');
        // Scroll into view if needed
        if (card.scrollIntoViewIfNeeded) card.scrollIntoViewIfNeeded(false);
        else card.scrollIntoView({ block: 'nearest' });
        break;
      }
    }
  }

  _updateSortBtn(btn) {
    btn.textContent = this._sortMode === 'recent' ? '\u23F1' : '\uD83D\uDCC1';
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
      { id: 'archived', label: 'Archived', color: 'var(--text-dim)' },
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
    // Default state: 4 non-archived filters on, archived off
    const isDefault = this._statusFilter.size === 4 && !this._statusFilter.has('archived');
    btn.style.color = isDefault ? '' : 'var(--accent-hover)';
    btn.title = isDefault ? 'Filter by status' : `Showing: ${[...this._statusFilter].join(', ')}`;
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

    // Archive filter: hide archived sessions unless 'archived' filter is on
    const showArchived = this._statusFilter.has('archived');
    if (showArchived) {
      // When archived filter is on, show only archived (plus any other enabled statuses for non-archived)
      sessions = sessions.filter(s => {
        if (this._archivedIds.has(s.sessionId)) return true;
        return this._statusFilter.has(s.status);
      });
    } else {
      // Hide archived sessions, then apply status filter
      sessions = sessions.filter(s => !this._archivedIds.has(s.sessionId));
      // Status filter (apply only when not all 4 non-archived statuses are selected)
      const nonArchivedFilters = new Set([...this._statusFilter]);
      nonArchivedFilters.delete('archived');
      if (nonArchivedFilters.size < 4) {
        sessions = sessions.filter(s => nonArchivedFilters.has(s.status));
      }
    }

    this.listEl.innerHTML = '';

    // "New Session" card at the top
    const newCard = document.createElement('div'); newCard.className = 'session-item-card new-session-card';
    newCard.innerHTML = '<div class="session-card-name" style="color:var(--accent-hover)">+ New Session</div>';
    newCard.onclick = () => this.app.showNewSessionDialog();
    this.listEl.appendChild(newCard);

    if (!sessions.length) { this.listEl.insertAdjacentHTML('beforeend', '<div class="empty-hint">No sessions</div>'); return; }

    if (this._activeTab === 'groups') {
      this._renderByGroups(sessions);
    } else {
      this._renderGrouped(sessions);
    }
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
      header.innerHTML = `<span class="folder-chevron">\u25BC</span><span class="folder-path">${cwdShort}</span><span class="folder-count">${items.length}</span>`;
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
      this._sortSessions(items);
      for (const s of items) { sessionsDiv.appendChild(this._renderSessionCard(s)); }

      group.append(header, sessionsDiv);
      this.listEl.appendChild(group);
    }
  }

  _renderByGroups(sessions) {
    const sessionById = new Map();
    for (const s of sessions) sessionById.set(s.sessionId, s);

    const groupNames = this._getGroupNames();
    const assignedIds = new Set();

    // "+" button to add new group
    const addGroupCard = document.createElement('div');
    addGroupCard.className = 'session-item-card new-session-card';
    addGroupCard.innerHTML = '<div class="session-card-name" style="color:var(--accent-hover)">+ New Group</div>';
    addGroupCard.onclick = () => {
      const name = prompt('Group name:');
      if (name && name.trim()) this._createGroup(name.trim());
    };
    this.listEl.appendChild(addGroupCard);

    // Render each group
    for (const groupName of groupNames) {
      const groupSessionIds = this._sessionGroups[groupName] || [];
      const groupSessions = groupSessionIds.map(id => sessionById.get(id)).filter(Boolean);
      groupSessionIds.forEach(id => { if (sessionById.has(id)) assignedIds.add(id); });

      const groupEl = document.createElement('div');
      groupEl.className = 'folder-group';
      const collapseKey = 'group:' + groupName;
      if (this._collapsedFolders.has(collapseKey)) groupEl.classList.add('collapsed');

      const hasLive = groupSessions.some(s => s.status === 'live' || s.status === 'tmux');

      const header = document.createElement('div');
      header.className = 'folder-header';
      header.innerHTML = `<span class="folder-chevron">\u25BC</span><span class="folder-path" style="direction:ltr">${escHtml(groupName)}</span><span class="folder-count">${groupSessions.length}</span>`;
      if (hasLive) {
        const dot = document.createElement('span');
        dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0';
        header.insertBefore(dot, header.children[2]);
      }

      // Delete group button
      const delBtn = document.createElement('button');
      delBtn.className = 'folder-add-btn';
      delBtn.textContent = '\u00D7';
      delBtn.title = 'Delete group "' + groupName + '"';
      delBtn.onclick = (e) => {
        e.stopPropagation();
        if (confirm('Delete group "' + groupName + '"? (Sessions will not be deleted)')) {
          this._deleteGroup(groupName);
        }
      };
      header.appendChild(delBtn);

      header.onclick = (e) => {
        if (e.target.closest('.folder-add-btn')) return;
        groupEl.classList.toggle('collapsed');
        if (groupEl.classList.contains('collapsed')) this._collapsedFolders.add(collapseKey);
        else this._collapsedFolders.delete(collapseKey);
        localStorage.setItem('collapsedFolders', JSON.stringify([...this._collapsedFolders]));
      };

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = 'folder-sessions';
      // Sort: starred first, then by time
      this._sortSessions(groupSessions);
      for (const s of groupSessions) sessionsDiv.appendChild(this._renderSessionCard(s));

      if (groupSessions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-hint';
        empty.textContent = 'No sessions in this group';
        sessionsDiv.appendChild(empty);
      }

      groupEl.append(header, sessionsDiv);
      this.listEl.appendChild(groupEl);
    }

    // Ungrouped section
    const ungrouped = sessions.filter(s => !assignedIds.has(s.sessionId));
    if (ungrouped.length > 0) {
      const groupEl = document.createElement('div');
      groupEl.className = 'folder-group';
      const collapseKey = 'group:__ungrouped__';
      if (this._collapsedFolders.has(collapseKey)) groupEl.classList.add('collapsed');

      const header = document.createElement('div');
      header.className = 'folder-header';
      header.innerHTML = `<span class="folder-chevron">\u25BC</span><span class="folder-path" style="direction:ltr;font-style:italic">Ungrouped</span><span class="folder-count">${ungrouped.length}</span>`;

      header.onclick = () => {
        groupEl.classList.toggle('collapsed');
        if (groupEl.classList.contains('collapsed')) this._collapsedFolders.add(collapseKey);
        else this._collapsedFolders.delete(collapseKey);
        localStorage.setItem('collapsedFolders', JSON.stringify([...this._collapsedFolders]));
      };

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = 'folder-sessions';
      this._sortSessions(ungrouped);
      for (const s of ungrouped) sessionsDiv.appendChild(this._renderSessionCard(s));

      groupEl.append(header, sessionsDiv);
      this.listEl.appendChild(groupEl);
    }
  }

  _renderSessionCard(s) {
    const card = document.createElement('div'); card.className = 'session-item-card';
    card._sessionId = s.sessionId; // Store for highlight lookup
    const isArchived = this._archivedIds.has(s.sessionId);
    if (isArchived) card.classList.add('archived');
    if (this._expandedCardId === s.sessionId) card.classList.add('expanded');
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
    const isExpanded = this._expandedCardId === s.sessionId;
    // Compact row: star archive name badge expand
    card.innerHTML = `<div class="session-card-row">
      <span class="session-card-name">${escHtml(displayName)}</span>
      <span class="session-card-badge ${badge.cls}">${badge.text}</span>
    </div>`;
    const row = card.querySelector('.session-card-row');
    // Star button (inline, always visible)
    const starBtn = document.createElement('button');
    starBtn.className = 'session-inline-btn' + (starred ? ' starred' : '');
    starBtn.textContent = starred ? '\u2605' : '\u2606';
    starBtn.title = starred ? 'Unstar' : 'Star';
    starBtn.onclick = (e) => { e.stopPropagation(); this.toggleStar(s.sessionId); };
    row.insertBefore(starBtn, row.firstChild);
    // Archive button (inline, always visible)
    const archBtn = document.createElement('button');
    archBtn.className = 'session-inline-btn' + (isArchived ? ' archived' : '');
    archBtn.textContent = isArchived ? '\u{1F4E4}' : '\u{1F4E6}';
    archBtn.title = isArchived ? 'Unarchive' : 'Archive';
    archBtn.onclick = (e) => { e.stopPropagation(); this.toggleArchive(s.sessionId); };
    row.insertBefore(archBtn, row.children[1]);

    // Expand/collapse button on the right side, after badge
    const expandBtn = document.createElement('button');
    expandBtn.className = 'session-expand-btn';
    expandBtn.textContent = this._expandedCardId === s.sessionId ? '\u25BE' : '\u25B8';
    expandBtn.title = 'Show details';
    expandBtn.onclick = (e) => {
      e.stopPropagation();
      if (this._expandedCardId === s.sessionId) {
        this._expandedCardId = null;
      } else {
        this._expandedCardId = s.sessionId;
      }
      this._render();
    };
    card.querySelector('.session-card-row').appendChild(expandBtn);

    // Detail panel (shown when expanded)
    const detailPanel = document.createElement('div');
    detailPanel.className = 'session-card-detail';

    const cwdShort = (s.cwd || '').replace(/^\/home\/[^/]+/, '~');

    detailPanel.innerHTML = `
      <div class="session-detail-row">
        <span class="session-detail-label">ID</span>
        <span class="session-detail-value session-detail-id">${escHtml(idShort)}...<button class="session-detail-copy" title="Copy full ID">&#x1F4CB;</button></span>
      </div>
      <div class="session-detail-row">
        <span class="session-detail-label">CWD</span>
        <span class="session-detail-value" title="${escHtml(s.cwd || '')}">${escHtml(cwdShort)}</span>
      </div>
      <div class="session-detail-row">
        <span class="session-detail-label">Started</span>
        <span class="session-detail-value">${date.toLocaleString()}</span>
      </div>
      <div class="session-detail-row">
        <span class="session-detail-label">Status</span>
        <span class="session-detail-value"><span class="session-card-badge ${badge.cls}">${badge.text}</span></span>
      </div>
      <div class="session-detail-groups"></div>
      <div class="session-detail-actions"></div>
    `;

    // Copy ID button
    const copyBtn = detailPanel.querySelector('.session-detail-copy');
    if (copyBtn) {
      copyBtn.onclick = (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(s.sessionId).then(() => { copyBtn.textContent = '\u2713'; setTimeout(() => { copyBtn.textContent = '\u{1F4CB}'; }, 1500); });
      };
    }

    // Groups section in detail panel
    this._renderDetailGroups(detailPanel.querySelector('.session-detail-groups'), s.sessionId);

    // Action buttons in detail panel (star/archive already in compact row)
    const actionsDiv = detailPanel.querySelector('.session-detail-actions');

    // Rename button
    const detailRenameBtn = document.createElement('button');
    detailRenameBtn.className = 'session-detail-btn';
    detailRenameBtn.textContent = '\u270F Rename';
    detailRenameBtn.onclick = (e) => { e.stopPropagation(); this.renameSession(s.sessionId, originalName); };
    actionsDiv.appendChild(detailRenameBtn);

    // Resume/Attach action button
    if (s.status === 'live' && s.webuiId) {
      const detailAttachBtn = document.createElement('button');
      detailAttachBtn.className = 'session-detail-btn session-detail-btn-primary';
      detailAttachBtn.textContent = '\u25B6 Attach';
      detailAttachBtn.onclick = (e) => { e.stopPropagation(); this.app.attachSession(s.webuiId, s.webuiName || displayName, s.cwd); };
      actionsDiv.appendChild(detailAttachBtn);
    } else if (s.status === 'tmux') {
      const detailTmuxBtn = document.createElement('button');
      detailTmuxBtn.className = 'session-detail-btn session-detail-btn-primary';
      detailTmuxBtn.textContent = '\u25B6 View';
      detailTmuxBtn.onclick = (e) => { e.stopPropagation(); this.app.attachTmuxSession(s.tmuxTarget, displayName, s.cwd); };
      actionsDiv.appendChild(detailTmuxBtn);
    } else if (s.status === 'stopped') {
      const detailResumeBtn = document.createElement('button');
      detailResumeBtn.className = 'session-detail-btn session-detail-btn-primary';
      detailResumeBtn.textContent = '\u25B6 Resume';
      detailResumeBtn.onclick = (e) => { e.stopPropagation(); this.app.resumeSession(s.sessionId, s.cwd, customName || s.name); };
      actionsDiv.appendChild(detailResumeBtn);
    }

    card.appendChild(detailPanel);

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
      card.title = 'Running in tmux \u2014 click to view (closing won\'t kill it)';
    } else if (s.status === 'external') {
      card.style.opacity = '0.7'; card.style.cursor = 'default';
      card.title = 'Running in unsupported terminal (PID ' + (s.pid || '?') + ')';
    } else if (s.status === 'stopped') {
      card.onclick = () => this.app.resumeSession(s.sessionId, s.cwd, customName || s.name);
    }
    return card;
  }

  _renderDetailGroups(container, sessionId) {
    container.innerHTML = '';
    const sessionGroups = this._getSessionGroups(sessionId);
    const summary = sessionGroups.length ? sessionGroups.join(', ') : 'None';

    // Single row: "Groups: X, Y" + dropdown button
    const row = document.createElement('div');
    row.className = 'session-detail-row';
    row.innerHTML = `<span class="session-detail-label">Groups</span><span class="session-detail-value" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(summary)}</span>`;
    const btn = document.createElement('button');
    btn.className = 'session-detail-btn';
    btn.textContent = '▾';
    btn.style.cssText = 'padding:1px 6px;font-size:10px;min-width:0';
    btn.onclick = (e) => {
      e.stopPropagation();
      this._showGroupsPopover(btn, sessionId);
    };
    row.appendChild(btn);
    container.appendChild(row);
  }

  _showGroupsPopover(anchor, sessionId) {
    document.querySelectorAll('.groups-popover').forEach(p => p.remove());
    const pop = document.createElement('div');
    pop.className = 'groups-popover';
    const rect = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.left = rect.left + 'px';
    pop.style.top = (rect.bottom + 2) + 'px';
    pop.style.zIndex = '99999';

    const groupNames = this._getGroupNames();
    const sessionGroups = this._getSessionGroups(sessionId);

    for (const name of groupNames) {
      const row = document.createElement('label');
      row.className = 'session-detail-group-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = sessionGroups.includes(name);
      cb.onchange = (e) => {
        e.stopPropagation();
        if (cb.checked) this._addSessionToGroup(sessionId, name);
        else this._removeSessionFromGroup(sessionId, name);
      };
      const lbl = document.createElement('span');
      lbl.textContent = name;
      row.append(cb, lbl);
      row.onclick = (e) => e.stopPropagation();
      pop.appendChild(row);
    }

    const createRow = document.createElement('div');
    createRow.className = 'session-detail-group-create';
    createRow.textContent = '+ New group';
    createRow.onclick = (e) => {
      e.stopPropagation();
      const name = prompt('New group name:');
      if (name && name.trim()) {
        this._createGroup(name.trim());
        this._addSessionToGroup(sessionId, name.trim());
        pop.remove();
      }
    };
    pop.appendChild(createRow);

    document.body.appendChild(pop);
    attachPopoverClose(pop, anchor);
  }

}

export { Sidebar };
