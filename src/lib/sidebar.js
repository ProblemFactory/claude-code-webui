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
    this._sessionModes = JSON.parse(localStorage.getItem('sessionModes') || '{}'); // { sessionId: 'terminal'|'chat' }
    this._sessionGroups = JSON.parse(localStorage.getItem('sessionGroups') || '{}'); // { groupName: [sessionId, ...] }
    this._groupFolders = JSON.parse(localStorage.getItem('groupFolders') || '{}'); // { groupName: [folderPath, ...] }

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
    const defaultFilter = this.app.settings?.get('sidebar.defaultStatusFilter') ?? ['live', 'tmux', 'external', 'stopped'];
    this._statusFilter = new Set(defaultFilter);
    this._activeView = null; // null = ALL (show all selected filters), or a specific status string
    const filterBtn = document.getElementById('live-filter');
    filterBtn.onclick = (e) => { e.stopPropagation(); this._showStatusFilterMenu(filterBtn); };
    // Apply defaultStatusFilter once after async settings load (setting may differ from schema default)
    const _applyDefaultFilter = (val) => {
      this._statusFilter = new Set(val);
      this._activeView = null;
      this._updateFilterBtn(filterBtn);
      this._render();
      this.app.settings?.off('sidebar.defaultStatusFilter', _applyDefaultFilter);
    };
    this.app.settings?.on('sidebar.defaultStatusFilter', _applyDefaultFilter);
    this._renderQuickTabs();
    // Re-render quick tabs after settings finish loading (async)
    this.app.settings?.on('sidebar.enableStatusQuickTabs', () => this._renderQuickTabs());

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
    if (state.sessionModes) {
      this._sessionModes = { ...state.sessionModes };
      localStorage.setItem('sessionModes', JSON.stringify(state.sessionModes));
    }
    if (state.sessionGroups) {
      this._sessionGroups = { ...state.sessionGroups };
      localStorage.setItem('sessionGroups', JSON.stringify(state.sessionGroups));
    }
    if (state.groupFolders) {
      this._groupFolders = { ...state.groupFolders };
      localStorage.setItem('groupFolders', JSON.stringify(state.groupFolders));
    }
  }

  async _pushUserState() {
    const state = {
      starredSessions: [...this._starredIds],
      archivedSessions: [...this._archivedIds],
      customNames: this._customNames,
      sessionModes: this._sessionModes,
      sessionGroups: this._sessionGroups,
      groupFolders: this._groupFolders,
    };
    localStorage.setItem('starredSessions', JSON.stringify(state.starredSessions));
    localStorage.setItem('archivedSessions', JSON.stringify(state.archivedSessions));
    localStorage.setItem('sessionCustomNames', JSON.stringify(state.customNames));
    localStorage.setItem('sessionModes', JSON.stringify(state.sessionModes));
    localStorage.setItem('sessionGroups', JSON.stringify(state.sessionGroups));
    localStorage.setItem('groupFolders', JSON.stringify(state.groupFolders));
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
  getSessionMode(sessionId) { return this._sessionModes[sessionId] || null; }
  setSessionMode(sessionId, mode) { this._sessionModes[sessionId] = mode; this._pushUserState(); }

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

  _addFolderToGroup(folderPath, groupName) {
    if (!this._groupFolders[groupName]) this._groupFolders[groupName] = [];
    if (!this._groupFolders[groupName].includes(folderPath)) {
      this._groupFolders[groupName].push(folderPath);
      this._pushUserState();
      this._render();
    }
  }

  _removeFolderFromGroup(folderPath, groupName) {
    if (!this._groupFolders[groupName]) return;
    this._groupFolders[groupName] = this._groupFolders[groupName].filter(p => p !== folderPath);
    this._pushUserState();
    this._render();
  }

  // Get all sessions in a group: direct + folder-matched (recursive)
  _getGroupSessions(groupName, allSessions) {
    const directIds = new Set(this._sessionGroups[groupName] || []);
    const folders = this._groupFolders[groupName] || [];
    const result = new Set(directIds);
    for (const s of allSessions) {
      if (result.has(s.sessionId)) continue;
      const cwd = s.cwd || '';
      for (const fp of folders) {
        if (cwd === fp || cwd.startsWith(fp + '/')) { result.add(s.sessionId); break; }
      }
    }
    return result;
  }

  _createGroup(name) {
    if (!name || this._sessionGroups[name]) return;
    this._sessionGroups[name] = [];
    this._pushUserState();
    this._render();
  }

  _deleteGroup(name) {
    delete this._sessionGroups[name];
    delete this._groupFolders[name];
    this._pushUserState();
    this._render();
  }

  _renameGroup(oldName, newName) {
    if (this._sessionGroups[newName]) return; // name taken
    this._sessionGroups[newName] = this._sessionGroups[oldName] || [];
    delete this._sessionGroups[oldName];
    if (this._groupFolders[oldName]) {
      this._groupFolders[newName] = this._groupFolders[oldName];
      delete this._groupFolders[oldName];
    }
    this._pushUserState();
    this._render();
  }

  // ── Highlight / Sort / Filter ──

  highlightSession(sessionId) {
    this.listEl.querySelectorAll('.session-item-card').forEach(c => c.classList.remove('highlighted', 'highlight-flash'));
    if (!sessionId) return;
    const cards = this.listEl.querySelectorAll('.session-item-card');
    for (const card of cards) {
      if (card._sessionId === sessionId) {
        card.classList.add('highlighted');
        requestAnimationFrame(() => card.classList.add('highlight-flash'));
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
        this._activeView = null; // reset to ALL when filter changes
        this._updateFilterBtn(anchor);
        this._renderQuickTabs();
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

  _renderQuickTabs() {
    const enabled = this.app.settings?.get('sidebar.enableStatusQuickTabs') ?? false;
    const container = document.getElementById('status-quick-tabs');
    if (!container) return;
    container.innerHTML = '';
    const filters = [...this._statusFilter];
    // Only show tabs if enabled and more than 1 filter is selected
    if (!enabled || filters.length <= 1) return;

    const labelMap = { live: 'LIVE', tmux: 'TMUX', external: 'EXT', stopped: 'STOP', archived: 'ARCH' };
    const colorMap = { live: 'var(--green)', tmux: 'var(--blue)', external: 'var(--yellow)', stopped: 'var(--text-dim)', archived: 'var(--text-dim)' };

    // ALL button
    const allBtn = document.createElement('button'); allBtn.className = 'status-quick-tab';
    if (this._activeView === null) allBtn.classList.add('active');
    allBtn.textContent = 'ALL';
    allBtn.onclick = () => { this._activeView = null; this._renderQuickTabs(); this._render(); };
    container.appendChild(allBtn);

    for (const f of filters) {
      const btn = document.createElement('button'); btn.className = 'status-quick-tab';
      if (this._activeView === f) btn.classList.add('active');
      btn.textContent = labelMap[f] || f.toUpperCase();
      btn.style.setProperty('--tab-color', colorMap[f] || 'var(--text-dim)');
      btn.onclick = () => { this._activeView = f; this._renderQuickTabs(); this._render(); };
      container.appendChild(btn);
    }
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
      return { ...s, status, webuiId: wm?.id || null, webuiName: wm?.name || null, webuiMode: wm?.mode || 'terminal' };
    });

    for (const ws of webui) {
      if (!matchedWebuiIds.has(ws.id)) {
        unified.unshift({ sessionId: ws.claudeSessionId || ws.id, cwd: ws.cwd, startedAt: ws.createdAt, status: 'live', webuiId: ws.id, webuiName: ws.name, name: ws.name || '', webuiMode: ws.mode || 'terminal' });
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

    // Quick tab view: narrow down to a single status
    if (this._activeView) {
      sessions = sessions.filter(s => s.status === this._activeView);
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

      // Link folder to group button
      const linkBtn = document.createElement('button'); linkBtn.className = 'folder-add-btn';
      linkBtn.textContent = '\u{1F517}'; linkBtn.title = 'Add folder to group';
      linkBtn.style.fontSize = '10px';
      linkBtn.onclick = (e) => {
        e.stopPropagation();
        this._showFolderGroupPopover(linkBtn, cwd);
      };
      header.appendChild(linkBtn);

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

    // Render each group (direct sessions + folder-matched sessions)
    for (const groupName of groupNames) {
      const groupSessionIds = this._getGroupSessions(groupName, sessions);
      const groupSessions = [...groupSessionIds].map(id => sessionById.get(id)).filter(Boolean);
      groupSessionIds.forEach(id => assignedIds.add(id));

      const groupEl = document.createElement('div');
      groupEl.className = 'folder-group';
      const collapseKey = 'group:' + groupName;
      if (this._collapsedFolders.has(collapseKey)) groupEl.classList.add('collapsed');

      const hasLive = groupSessions.some(s => s.status === 'live' || s.status === 'tmux');

      const linkedFolders = this._groupFolders[groupName] || [];
      const folderHint = linkedFolders.length ? ` (${linkedFolders.length} folder${linkedFolders.length > 1 ? 's' : ''})` : '';

      const header = document.createElement('div');
      header.className = 'folder-header';
      header.innerHTML = `<span class="folder-chevron">\u25BC</span><span class="folder-path" style="direction:ltr">${escHtml(groupName)}<span style="color:var(--text-dim);font-weight:400;font-size:10px">${folderHint}</span></span><span class="folder-count">${groupSessions.length}</span>`;
      if (hasLive) {
        const dot = document.createElement('span');
        dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0';
        header.insertBefore(dot, header.children[2]);
      }

      // Double-click group name to rename
      const nameSpan = header.querySelector('.folder-path');
      if (nameSpan) {
        nameSpan.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          const newName = prompt('Rename group:', groupName);
          if (newName && newName.trim() && newName.trim() !== groupName) {
            this._renameGroup(groupName, newName.trim());
          }
        });
        nameSpan.title = 'Double-click to rename';
      }

      // Resume all stopped sessions in group
      const resumeAllBtn = document.createElement('button');
      resumeAllBtn.className = 'folder-add-btn';
      resumeAllBtn.textContent = '\u25B6';
      resumeAllBtn.title = 'Resume all sessions in "' + groupName + '"';
      resumeAllBtn.onclick = (e) => {
        e.stopPropagation();
        for (const s of groupSessions) {
          if (s.status === 'stopped') {
            const customName = this.getCustomName(s.sessionId);
            this.app.resumeSession(s.sessionId, s.cwd, customName || s.name);
          } else if (s.status === 'live' && s.webuiId) {
            this.app.attachSession(s.webuiId, s.webuiName || s.name, s.cwd, { mode: s.webuiMode });
          } else if (s.status === 'tmux') {
            this.app.attachTmuxSession(s.tmuxTarget, s.name, s.cwd);
          }
        }
      };
      header.appendChild(resumeAllBtn);

      // Right-click context menu (Rename / Linked Folders / Delete)
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        this._showGroupContextMenu(e.clientX, e.clientY, groupName);
      });

      // Drop target on entire group (header + expanded session area)
      const _setupGroupDrop = (el) => {
        el.addEventListener('dragover', (e) => {
          if (e.dataTransfer.types.includes('application/x-folder-path') || e.dataTransfer.types.includes('application/x-session-id')) {
            e.preventDefault(); e.stopPropagation(); header.classList.add('drop-target');
          }
        });
        el.addEventListener('dragleave', (e) => {
          if (!groupEl.contains(e.relatedTarget)) header.classList.remove('drop-target');
        });
        el.addEventListener('drop', (e) => {
          e.preventDefault(); e.stopPropagation(); header.classList.remove('drop-target');
          const folderPath = e.dataTransfer.getData('application/x-folder-path');
          const sessionId = e.dataTransfer.getData('application/x-session-id');
          if (folderPath) this._addFolderToGroup(folderPath, groupName);
          else if (sessionId) this._assignSessionToGroup(sessionId, groupName);
        });
      };
      _setupGroupDrop(groupEl);

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
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-session-id', s.sessionId);
      e.dataTransfer.effectAllowed = 'link';
    });
    const isArchived = this._archivedIds.has(s.sessionId);
    if (isArchived) card.classList.add('archived');
    if (this._expandedCardId === s.sessionId) card.classList.add('expanded');
    const date = new Date(s.startedAt);
    const customName = this._customNames[s.sessionId];
    const cwdFolder = s.cwd ? s.cwd.replace(/\/+$/, '').split('/').pop() : '';
    const originalName = s.name || s.webuiName || cwdFolder || s.sessionId.substring(0, 12) + '...';
    const displayName = customName || originalName;

    const badgeMap = {
      live:     { cls: 'badge-live', text: 'LIVE' },
      tmux:     { cls: 'badge-tmux', text: 'TMUX' },
      external: { cls: 'badge-external', text: 'EXTERNAL' },
      stopped:  { cls: 'badge-stopped', text: 'STOPPED' },
    };
    const badge = badgeMap[s.status] || badgeMap.stopped;

    const starred = this._starredIds.has(s.sessionId);
    const isExpanded = this._expandedCardId === s.sessionId;
    // Compact row: star archive name [mode] badge expand
    const modeIcon = s.webuiMode === 'chat' ? '<span class="session-mode-icon" title="Chat mode">\uD83D\uDCAC</span>' : '';
    card.innerHTML = `<div class="session-card-row">
      <span class="session-card-name">${escHtml(displayName)}</span>
      ${modeIcon}<span class="session-card-badge ${badge.cls}">${badge.text}</span>
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

    const settings = this.app.settings;
    const visibleFields = settings?.get('sessionCard.visibleFields') ?? ['id', 'cwd', 'started', 'status', 'groups'];
    const clickToCopy = settings?.get('sessionCard.clickToCopy') ?? false;
    const truncation = settings?.get('sessionCard.detailTruncation') ?? 'left';
    const cwdShort = (s.cwd || '').replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');

    const fields = [
      { key: 'id', label: 'ID', display: s.sessionId, copy: s.sessionId, copiable: true, midTruncate: true },
      { key: 'cwd', label: 'CWD', display: cwdShort, copy: s.cwd || '', copiable: true, leftTruncate: true },
      { key: 'started', label: 'Started', display: date.toLocaleString(), copy: date.toISOString() },
      { key: 'status', label: 'Status', display: null, badge: true, copy: `${s.status}${s.pid ? ' PID ' + s.pid : ''}` },
    ];

    for (const f of fields) {
      if (!visibleFields.includes(f.key)) continue;
      const row = document.createElement('div'); row.className = 'session-detail-row';
      row.style.position = 'relative';
      const lbl = document.createElement('span'); lbl.className = 'session-detail-label'; lbl.textContent = f.label;
      const val = document.createElement('span'); val.className = 'session-detail-value';
      if (f.badge) {
        val.innerHTML = `<span class="session-card-badge ${badge.cls}">${badge.text}</span>`;
      } else if (f.midTruncate && f.display.length > 12) {
        // Middle truncation: flexible head (ellipsis) + fixed tail
        val.classList.add('session-detail-mid-truncate');
        const head = document.createElement('span'); head.className = 'mid-truncate-head'; head.textContent = f.display.slice(0, -4);
        const tail = document.createElement('span'); tail.className = 'mid-truncate-tail'; tail.textContent = f.display.slice(-4);
        val.append(head, tail);
      } else {
        val.textContent = f.display;
        val.style.display = 'block';
        if (f.leftTruncate) { val.style.direction = 'rtl'; val.style.unicodeBidi = 'plaintext'; }
      }
      if (f.copiable || clickToCopy) {
        val.classList.add('session-detail-copyable');
        val.title = f.copy;
        val.onclick = (e) => {
          e.stopPropagation();
          const showTip = () => {
            const tip = document.createElement('span');
            tip.className = 'session-detail-tooltip';
            tip.textContent = 'Copied!';
            row.appendChild(tip);
            setTimeout(() => tip.remove(), 1000);
          };
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(f.copy).then(showTip).catch(() => {
              this._fallbackCopy(f.copy); showTip();
            });
          } else {
            this._fallbackCopy(f.copy); showTip();
          }
        };
      }
      row.append(lbl, val);
      detailPanel.appendChild(row);
    }

    // Groups section
    if (visibleFields.includes('groups')) {
      const groupsContainer = document.createElement('div'); groupsContainer.className = 'session-detail-groups';
      detailPanel.appendChild(groupsContainer);
      this._renderDetailGroups(groupsContainer, s.sessionId, clickToCopy);
    }

    const actionsDiv = document.createElement('div'); actionsDiv.className = 'session-detail-actions';
    detailPanel.appendChild(actionsDiv);

    // Rename button
    const detailRenameBtn = document.createElement('button');
    detailRenameBtn.className = 'session-detail-btn';
    detailRenameBtn.textContent = '\u270F Rename';
    detailRenameBtn.onclick = (e) => { e.stopPropagation(); this.renameSession(s.sessionId, originalName); };
    actionsDiv.appendChild(detailRenameBtn);

    // Find button — highlight the window + taskbar item with fast blink
    if (s.webuiId) {
      const findBtn = document.createElement('button');
      findBtn.className = 'session-detail-btn';
      findBtn.textContent = '\uD83D\uDD0D Find';
      findBtn.onclick = (e) => {
        e.stopPropagation();
        this.app.flashWindow(s.webuiId);
      };
      actionsDiv.appendChild(findBtn);
    }

    // Resume/Attach action button
    if (s.status === 'live' && s.webuiId) {
      const detailAttachBtn = document.createElement('button');
      detailAttachBtn.className = 'session-detail-btn session-detail-btn-primary';
      detailAttachBtn.textContent = '\u25B6 Attach';
      detailAttachBtn.onclick = (e) => { e.stopPropagation(); this.app.attachSession(s.webuiId, s.webuiName || displayName, s.cwd, { mode: s.webuiMode }); };
      actionsDiv.appendChild(detailAttachBtn);
    } else if (s.status === 'tmux') {
      const detailTmuxBtn = document.createElement('button');
      detailTmuxBtn.className = 'session-detail-btn session-detail-btn-primary';
      detailTmuxBtn.textContent = '\u25B6 View';
      detailTmuxBtn.onclick = (e) => { e.stopPropagation(); this.app.attachTmuxSession(s.tmuxTarget, displayName, s.cwd); };
      actionsDiv.appendChild(detailTmuxBtn);
    } else if (s.status === 'stopped') {
      const savedMode = this.getSessionMode(s.sessionId);
      const defaultMode = this.app.settings.get('session.defaultMode') ?? 'terminal';
      let resumeMode = savedMode || defaultMode;

      const resumeWrap = document.createElement('div');
      resumeWrap.className = 'session-resume-split';

      const resumeBtn = document.createElement('button');
      const dropBtn = document.createElement('button');
      const updateLabel = () => {
        const isChat = resumeMode === 'chat';
        resumeBtn.textContent = isChat ? '\uD83D\uDCAC Resume in Chat' : '\u25B6 Resume in Terminal';
        resumeBtn.className = 'session-detail-btn ' + (isChat ? 'session-detail-btn-chat' : 'session-detail-btn-primary');
        dropBtn.className = 'session-resume-drop ' + (isChat ? 'session-detail-btn-chat' : 'session-detail-btn-primary');
      };
      updateLabel();
      resumeBtn.onclick = (e) => { e.stopPropagation(); this.app.resumeSession(s.sessionId, s.cwd, customName || s.name, { mode: resumeMode }); };

      dropBtn.textContent = '\u25BE';
      dropBtn.onclick = (e) => {
        e.stopPropagation();
        resumeMode = resumeMode === 'chat' ? 'terminal' : 'chat';
        this.setSessionMode(s.sessionId, resumeMode);
        updateLabel();
      };

      resumeWrap.append(resumeBtn, dropBtn);
      actionsDiv.appendChild(resumeWrap);

      // View History button (read-only, no resume)
      const viewBtn = document.createElement('button');
      viewBtn.className = 'session-detail-btn';
      viewBtn.textContent = '\uD83D\uDCCB View History';
      viewBtn.onclick = (e) => { e.stopPropagation(); this.app.viewSession(s.sessionId, s.cwd, customName || s.name); };
      actionsDiv.appendChild(viewBtn);
    }

    // Terminate button (for any running session)
    if (s.status !== 'stopped') {
      const terminateBtn = document.createElement('button');
      terminateBtn.className = 'session-detail-btn';
      terminateBtn.style.color = 'var(--red, #e55)';
      terminateBtn.textContent = '\u2715 Terminate';
      terminateBtn.onclick = (e) => {
        e.stopPropagation();
        if (!confirm('Terminate session "' + displayName + '"?')) return;
        if (s.webuiId) this.app.killSession(s.webuiId);
        else if (s.pid) this.app.killPid(s.pid);
      };
      actionsDiv.appendChild(terminateBtn);
    }

    card.appendChild(detailPanel);

    // Double-click name to rename (sets --name for next resume)
    const nameEl = card.querySelector('.session-card-name');
    if (nameEl) {
      if (customName) nameEl.title = `Custom name (--name on resume). Original: ${originalName}`;
      nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); this.renameSession(s.sessionId, originalName); });
    }

    const clickBehavior = settings?.get('sessionCard.clickBehavior') ?? 'focus';
    if (s.status === 'external') {
      card.style.opacity = '0.7';
      if (clickBehavior === 'focus') card.style.cursor = 'default';
      card.title = 'Running in unsupported terminal (PID ' + (s.pid || '?') + ')';
    }
    if (clickBehavior === 'expand') {
      // Click expands/collapses; use buttons inside detail to open/resume
      card.onclick = (e) => {
        if (e.target.closest('.session-detail-btn') || e.target.closest('.session-inline-btn') || e.target.closest('.session-expand-btn') || e.target.closest('.session-detail-copyable')) return;
        if (this._expandedCardId === s.sessionId) {
          this._expandedCardId = null;
        } else {
          this._expandedCardId = s.sessionId;
        }
        this._render();
      };
    } else if (clickBehavior === 'flash') {
      // Click flashes/bounces the corresponding window
      card.onclick = (e) => {
        if (e.target.closest('.session-detail-btn') || e.target.closest('.session-inline-btn') || e.target.closest('.session-expand-btn') || e.target.closest('.session-detail-copyable')) return;
        if (s.webuiId) this.app.flashWindow(s.webuiId);
        else if (s.status === 'live' && s.webuiId) this.app.attachSession(s.webuiId, s.webuiName || displayName, s.cwd, { mode: s.webuiMode });
        else if (s.status === 'tmux') this.app.attachTmuxSession(s.tmuxTarget, displayName, s.cwd);
        else if (s.status === 'stopped') this.app.resumeSession(s.sessionId, s.cwd, customName || s.name);
      };
    } else {
      // Default 'focus': click opens/resumes directly
      if (s.status === 'live' && s.webuiId) {
        card.onclick = () => this.app.attachSession(s.webuiId, s.webuiName || displayName, s.cwd, { mode: s.webuiMode });
      } else if (s.status === 'tmux') {
        card.onclick = () => this.app.attachTmuxSession(s.tmuxTarget, displayName, s.cwd);
        card.title = 'Running in tmux \u2014 click to view (closing won\'t kill it)';
      } else if (s.status === 'live') {
        // LIVE but no window open (e.g. layout didn't restore it) — click to attach
        card.onclick = () => this.app.attachSession(s.webuiId, s.webuiName || displayName, s.cwd, { mode: s.webuiMode });
      } else if (s.status === 'stopped') {
        card.onclick = () => this.app.resumeSession(s.sessionId, s.cwd, customName || s.name);
      }
    }
    return card;
  }

  _renderDetailGroups(container, sessionId, clickToCopy) {
    container.innerHTML = '';
    const sessionGroups = this._getSessionGroups(sessionId);
    const summary = sessionGroups.length ? sessionGroups.join(', ') : 'None';

    const row = document.createElement('div');
    row.className = 'session-detail-row';
    const lbl = document.createElement('span'); lbl.className = 'session-detail-label'; lbl.textContent = 'Groups';
    const val = document.createElement('span'); val.className = 'session-detail-value';
    val.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    val.textContent = summary;
    if (clickToCopy) {
      val.classList.add('session-detail-copyable');
      val.title = 'Click to copy';
      val.onclick = (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(summary).then(() => {
          const orig = val.textContent; val.textContent = 'Copied!';
          setTimeout(() => { val.textContent = orig; }, 800);
        }).catch(() => {});
      };
    }
    row.append(lbl, val);
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

  _showGroupFoldersPopover(anchor, groupName) {
    document.querySelectorAll('.groups-popover').forEach(p => p.remove());
    const pop = document.createElement('div');
    pop.className = 'groups-popover';
    const rect = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.left = rect.left + 'px';
    pop.style.top = (rect.bottom + 2) + 'px';
    pop.style.zIndex = '99999';

    const folders = this._groupFolders[groupName] || [];

    if (folders.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = 'No linked folders. Use \uD83D\uDD17 on folder headers in Folders tab, or drag folders here.';
      pop.appendChild(hint);
    } else {
      for (const fp of folders) {
        const row = document.createElement('div');
        row.className = 'session-detail-group-item';
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 8px;cursor:default';
        const pathSpan = document.createElement('span');
        pathSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px';
        pathSpan.textContent = fp.replace(/^\/home\/[^/]+/, '~');
        pathSpan.title = fp;
        const removeBtn = document.createElement('button');
        removeBtn.style.cssText = 'background:none;border:none;color:var(--red,#e55);cursor:pointer;font-size:12px;padding:0 4px;flex-shrink:0';
        removeBtn.textContent = '\u00D7';
        removeBtn.title = 'Unlink folder';
        removeBtn.onclick = (e) => {
          e.stopPropagation();
          this._removeFolderFromGroup(fp, groupName);
          pop.remove();
        };
        row.append(pathSpan, removeBtn);
        pop.appendChild(row);
      }
    }

    document.body.appendChild(pop);
    attachPopoverClose(pop, anchor);
  }

  _showGroupContextMenu(x, y, groupName) {
    document.querySelectorAll('.context-menu').forEach(m => m.remove());
    const menu = document.createElement('div'); menu.className = 'context-menu';
    menu.style.left = x + 'px'; menu.style.top = y + 'px';

    const items = [
      { label: 'Rename', action: () => {
        const n = prompt('Rename group:', groupName);
        if (n && n.trim() && n.trim() !== groupName) this._renameGroup(groupName, n.trim());
      }},
      { label: 'Linked folders', action: () => {
        // Show the folders popover anchored near the menu position
        const anchor = document.createElement('span');
        anchor.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;width:0;height:0';
        document.body.appendChild(anchor);
        this._showGroupFoldersPopover(anchor, groupName);
        anchor.remove();
      }},
      { separator: true },
      { label: 'Delete group', style: 'color:var(--red,#e55)', action: () => {
        if (confirm('Delete group "' + groupName + '"?\nSessions will not be deleted.')) this._deleteGroup(groupName);
      }},
    ];
    for (const item of items) {
      if (item.separator) { const sep = document.createElement('div'); sep.className = 'context-menu-separator'; menu.appendChild(sep); continue; }
      const el = document.createElement('div'); el.className = 'context-menu-item'; el.textContent = item.label;
      if (item.style) el.style.cssText = item.style;
      el.onclick = () => { menu.remove(); item.action(); };
      menu.appendChild(el);
    }
    // Keep menu on screen
    document.body.appendChild(menu);
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth) menu.style.left = (window.innerWidth - mr.width - 4) + 'px';
    if (mr.bottom > window.innerHeight) menu.style.top = (window.innerHeight - mr.height - 4) + 'px';
    attachPopoverClose(menu);
  }

  _assignSessionToGroup(sessionId, groupName) {
    if (!this._sessionGroups[groupName]) this._sessionGroups[groupName] = [];
    if (!this._sessionGroups[groupName].includes(sessionId)) {
      this._sessionGroups[groupName].push(sessionId);
      this._pushUserState();
      this._render();
    }
  }

  _showFolderGroupPopover(anchor, folderPath) {
    document.querySelectorAll('.groups-popover').forEach(p => p.remove());
    const pop = document.createElement('div');
    pop.className = 'groups-popover';
    const rect = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.left = rect.left + 'px';
    pop.style.top = (rect.bottom + 2) + 'px';
    pop.style.zIndex = '99999';

    const groupNames = this._getGroupNames();
    for (const name of groupNames) {
      const folders = this._groupFolders[name] || [];
      const isLinked = folders.includes(folderPath);
      const row = document.createElement('label');
      row.className = 'session-detail-group-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isLinked;
      cb.onchange = (e) => {
        e.stopPropagation();
        if (cb.checked) this._addFolderToGroup(folderPath, name);
        else this._removeFolderFromGroup(folderPath, name);
        pop.remove();
      };
      const lbl = document.createElement('span');
      lbl.textContent = name;
      row.append(cb, lbl);
      row.onclick = (e) => e.stopPropagation();
      pop.appendChild(row);
    }

    if (groupNames.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint'; hint.textContent = 'No groups yet';
      pop.appendChild(hint);
    }

    const createRow = document.createElement('div');
    createRow.className = 'session-detail-group-create';
    createRow.textContent = '+ New group';
    createRow.onclick = (e) => {
      e.stopPropagation();
      const name = prompt('New group name:');
      if (name && name.trim()) {
        this._createGroup(name.trim());
        this._addFolderToGroup(folderPath, name.trim());
        pop.remove();
      }
    };
    pop.appendChild(createRow);

    document.body.appendChild(pop);
    attachPopoverClose(pop, anchor);
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

  _fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

}

export { Sidebar };
