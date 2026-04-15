import { Resizer } from './resizer.js';
import { escHtml, createPopover, showContextMenu } from './utils.js';
import { createAgentKindIcon, createBackendIcon, getAgentKindMeta, getBackendMeta, getSessionKey } from './agent-meta.js';
import { renderSessionCard } from './session-card.js';
import { installSidebarState } from './sidebar-state.js';

class Sidebar {
  constructor(app) {
    this.app = app; this.el = document.getElementById('sidebar');
    this.listEl = document.getElementById('all-sessions-list');
    this.isOpen = false;
    this._resizePreviewEl = null;

    // Resizable sidebar width — handle inside sidebar (position:fixed can't use sibling)
    this._resizer = new Resizer(this.el, 'horizontal', {
      min: 200, max: 500, initial: parseInt(localStorage.getItem('sidebarWidth')) || 260,
      storageKey: 'sidebarWidth', inside: true, liveResize: false,
      onResizeStart: (w) => {
        this._setSidebarResizing(true);
        this._showSidebarResizePreview(w);
      },
      onResize: (w) => this._showSidebarResizePreview(w),
      onResizeEnd: (w) => {
        this._hideSidebarResizePreview();
        this._applySidebarLayoutWidth(w);
        this._fitVisibleSessions();
        requestAnimationFrame(() => this._setSidebarResizing(false));
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
    this._backendFilter = new Set(JSON.parse(localStorage.getItem('backendFilter') || '[]'));
    this._agentKindFilter = localStorage.getItem('agentKindFilter') || '';
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
    const backendFilterBtn = document.getElementById('backend-filter');
    backendFilterBtn.onclick = (e) => { e.stopPropagation(); this._showBackendFilterMenu(backendFilterBtn); };
    this._updateBackendFilterBtn(backendFilterBtn);
    // Apply defaultStatusFilter once after async settings load (setting may differ from schema default)
    const _applyDefaultFilter = (val) => {
      this._statusFilter = new Set(val);
      this._activeView = null;
      this._updateFilterBtn(filterBtn);
      this._updateBackendFilterBtn(backendFilterBtn);
      this._render();
      this.app.settings?.off('sidebar.defaultStatusFilter', _applyDefaultFilter);
    };
    this.app.settings?.on('sidebar.defaultStatusFilter', _applyDefaultFilter);
    this._renderQuickTabs();
    this._renderBackendQuickTabs();
    this._renderAgentKindQuickTabs();
    // Re-render quick tabs after settings finish loading (async)
    this.app.settings?.on('sidebar.enableStatusQuickTabs', () => this._renderQuickTabs());

    this._sessionDigest = '';
    app.ws.onGlobal((msg) => {
      if (msg.type === 'active-sessions') { this._webuiSessions = msg.sessions; this._mergeAndRender(); }
    });
    this._poll();
  }

  // State methods (star/archive/rename/groups/migration) installed by sidebar-state.js mixin

  // ── Tab Bar ──

  _buildTabBar() {
    const section = this.listEl.parentElement;
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
    section.insertBefore(tabBar, section.firstChild);
  }

  _updateTabs() {
    const tabs = this.el.querySelectorAll('.sidebar-tab');
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === this._activeTab));
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
    const menu = createPopover(anchor, 'status-filter-menu');

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
  }

  _getAvailableBackends() {
    const ids = new Set(this._backendFilter.size ? [...this._backendFilter] : ['claude']);
    for (const s of [...(this._systemSessions || []), ...(this._webuiSessions || [])]) {
      if (s.backend) ids.add(s.backend);
    }
    return [...ids];
  }

  _showBackendFilterMenu(anchor) {
    const menu = createPopover(anchor, 'status-filter-menu');
    const backends = this._getAvailableBackends();
    for (const id of backends) {
      const meta = getBackendMeta(id);
      const row = document.createElement('label'); row.className = 'status-filter-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this._backendFilter.size === 0 || this._backendFilter.has(id);
      const dot = createBackendIcon(id, { className: 'sidebar-backend-filter-icon', title: meta.label });
      const lbl = document.createElement('span'); lbl.textContent = meta.label;
      cb.onchange = () => {
        const next = this._backendFilter.size === 0 ? new Set(backends) : new Set(this._backendFilter);
        if (cb.checked) next.add(id); else next.delete(id);
        this._backendFilter = next.size === backends.length ? new Set() : next;
        localStorage.setItem('backendFilter', JSON.stringify([...this._backendFilter]));
        this._activeView = null;
        this._updateBackendFilterBtn(anchor);
        this._renderBackendQuickTabs();
        this._render();
      };
      row.append(cb, dot, lbl);
      menu.appendChild(row);
    }
  }

  _updateFilterBtn(btn) {
    // Default state: 4 non-archived filters on, archived off
    const isDefault = this._statusFilter.size === 4 && !this._statusFilter.has('archived');
    btn.style.color = isDefault ? '' : 'var(--accent-hover)';
    btn.title = isDefault ? 'Filter by status' : `Showing: ${[...this._statusFilter].join(', ')}`;
  }

  _updateBackendFilterBtn(btn) {
    const isDefault = this._backendFilter.size === 0;
    btn.style.color = isDefault ? '' : 'var(--accent-hover)';
    btn.title = isDefault ? 'Filter by agent backend' : `Agents: ${[...this._backendFilter].join(', ')}`;
    const iconIds = isDefault ? this._getAvailableBackends().slice(0, 2) : [...this._backendFilter].slice(0, 2);
    btn.replaceChildren();
    const stack = document.createElement('span');
    stack.className = 'backend-filter-icon-stack';
    if (!iconIds.length) {
      stack.textContent = '◎';
    } else {
      for (const id of iconIds) stack.appendChild(createBackendIcon(id, { className: 'backend-filter-btn-icon' }));
    }
    btn.appendChild(stack);
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

  _renderBackendQuickTabs() {
    const container = document.getElementById('backend-quick-tabs');
    if (!container) return;
    container.innerHTML = '';
    const backends = this._getAvailableBackends();
    if (backends.length <= 1) return;

    const allBtn = document.createElement('button'); allBtn.className = 'status-quick-tab';
    if (this._backendFilter.size === 0) allBtn.classList.add('active');
    allBtn.textContent = 'ALL';
    allBtn.title = 'Show all agent backends';
    allBtn.onclick = () => {
      this._backendFilter.clear();
      localStorage.setItem('backendFilter', JSON.stringify([]));
      this._updateBackendFilterBtn(document.getElementById('backend-filter'));
      this._renderBackendQuickTabs();
      this._render();
    };
    container.appendChild(allBtn);

    for (const id of backends) {
      const meta = getBackendMeta(id);
      const btn = document.createElement('button'); btn.className = 'status-quick-tab';
      if (this._backendFilter.size > 0 && this._backendFilter.has(id)) btn.classList.add('active');
      btn.title = meta.label;
      btn.appendChild(createBackendIcon(id, { className: 'backend-quick-tab-icon', title: meta.label }));
      btn.style.setProperty('--tab-color', meta.color);
      btn.onclick = () => {
        this._backendFilter = new Set([id]);
        localStorage.setItem('backendFilter', JSON.stringify([id]));
        this._updateBackendFilterBtn(document.getElementById('backend-filter'));
        this._renderBackendQuickTabs();
        this._render();
      };
      container.appendChild(btn);
    }
  }

  _getAvailableAgentKinds() {
    const kinds = new Set();
    for (const session of this._allSessions || []) {
      kinds.add(session.agentKind || 'primary');
    }
    return [...kinds];
  }

  _renderAgentKindQuickTabs() {
    const container = document.getElementById('agent-kind-quick-tabs');
    if (!container) return;
    container.innerHTML = '';
    const kinds = this._getAvailableAgentKinds();
    if (kinds.length <= 1 && !kinds.includes('subagent') && !kinds.includes('review')) return;

    const allBtn = document.createElement('button'); allBtn.className = 'status-quick-tab';
    if (!this._agentKindFilter) allBtn.classList.add('active');
    allBtn.textContent = 'ALL';
    allBtn.title = 'Show all agent types';
    allBtn.onclick = () => {
      this._agentKindFilter = '';
      localStorage.removeItem('agentKindFilter');
      this._renderAgentKindQuickTabs();
      this._render();
    };
    container.appendChild(allBtn);

    for (const kind of kinds.sort()) {
      const meta = getAgentKindMeta(kind);
      const btn = document.createElement('button'); btn.className = 'status-quick-tab';
      if (this._agentKindFilter === kind) btn.classList.add('active');
      btn.title = meta.label;
      btn.appendChild(createAgentKindIcon(kind, { className: 'agent-kind-quick-tab-icon', title: meta.label }));
      btn.style.setProperty('--tab-color', meta.color);
      btn.onclick = () => {
        this._agentKindFilter = kind;
        localStorage.setItem('agentKindFilter', kind);
        this._renderAgentKindQuickTabs();
        this._render();
      };
      container.appendChild(btn);
    }
  }

  _toggleCollapse(el, key) {
    el.classList.toggle('collapsed');
    if (el.classList.contains('collapsed')) this._collapsedFolders.add(key);
    else this._collapsedFolders.delete(key);
    localStorage.setItem('collapsedFolders', JSON.stringify([...this._collapsedFolders]));
  }

  _applySidebarLayoutWidth(width = this.el.offsetWidth) {
    document.getElementById('main-wrapper').style.marginLeft = this.isOpen ? `${width}px` : '0';
  }

  _setSidebarResizing(active) {
    document.getElementById('main-wrapper').classList.toggle('sidebar-resizing', !!active);
  }

  _ensureSidebarResizePreview() {
    if (this._resizePreviewEl) return this._resizePreviewEl;
    const el = document.createElement('div');
    el.className = 'sidebar-resize-preview';
    document.body.appendChild(el);
    this._resizePreviewEl = el;
    return el;
  }

  _showSidebarResizePreview(width) {
    const el = this._ensureSidebarResizePreview();
    el.style.transform = `translate3d(${Math.max(0, width) - 1}px, 0, 0)`;
    el.classList.add('visible');
  }

  _hideSidebarResizePreview() {
    if (!this._resizePreviewEl) return;
    this._resizePreviewEl.classList.remove('visible');
  }

  _fitVisibleSessions() {
    for (const [, session] of this.app.sessions) {
      if (!session.fit || !session.winInfo) continue;
      if (session.winInfo.isMinimized || session.winInfo._hiddenByDesktop) continue;
      session.fit();
    }
  }

  toggle(force) {
    this.isOpen = force !== undefined ? force : !this.isOpen;
    this.el.classList.toggle('open', this.isOpen);
    const wrapper = document.getElementById('main-wrapper');
    wrapper.classList.toggle('sidebar-open', this.isOpen);
    this._applySidebarLayoutWidth(this.el.offsetWidth);
    setTimeout(() => this._fitVisibleSessions(), 250);
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
      const wm = webui.find(ws =>
        (ws.backend || 'claude') === (s.backend || 'claude')
        && (ws.backendSessionId || ws.claudeSessionId || ws.id) === (s.backendSessionId || s.sessionId)
      );
      if (wm) matchedWebuiIds.add(wm.id);
      // Only upgrade to 'live' for dtach-managed sessions (not tmux/external — those keep their status)
      const status = (wm && s.status === 'stopped') ? 'live' : (wm && s.status !== 'tmux' && s.status !== 'external') ? 'live' : s.status;
      return {
        ...s,
        sessionKey: s.sessionKey || wm?.sessionKey || getSessionKey(s),
        status,
        sourceKind: s.sourceKind || wm?.sourceKind || null,
        agentKind: s.agentKind || wm?.agentKind || 'primary',
        agentRole: s.agentRole || wm?.agentRole || '',
        agentNickname: s.agentNickname || wm?.agentNickname || '',
        parentThreadId: s.parentThreadId || wm?.parentThreadId || null,
        webuiId: wm?.id || null,
        webuiName: wm?.name || null,
        webuiMode: wm?.mode || 'terminal',
      };
    });

    for (const ws of webui) {
      if (!matchedWebuiIds.has(ws.id)) {
        const backend = ws.backend || 'claude';
        const backendSessionId = ws.backendSessionId || ws.claudeSessionId || ws.id;
        unified.unshift({
          backend,
          backendSessionId,
          sessionKey: ws.sessionKey || `${backend}:${backendSessionId}`,
          claudeSessionId: ws.claudeSessionId || null,
          sessionId: backendSessionId,
          cwd: ws.cwd,
          startedAt: ws.createdAt,
          status: 'live',
          sourceKind: ws.sourceKind || null,
          agentKind: ws.agentKind || 'primary',
          agentRole: ws.agentRole || '',
          agentNickname: ws.agentNickname || '',
          parentThreadId: ws.parentThreadId || null,
          webuiId: ws.id,
          webuiName: ws.name,
          name: ws.name || '',
          webuiMode: ws.mode || 'terminal',
        });
      }
    }

    this._allSessions = unified;
  }

  _mergeAndRender() {
    this._merge();
    if (this._migrateUserStateKeys(this._allSessions)) {
      this._pushUserState();
    }
    const digest = JSON.stringify(this._allSessions.map(s => `${this._getSessionStateKey(s)}:${s.status}:${s.agentKind || 'primary'}:${s.agentRole || ''}:${s.agentNickname || ''}`));
    if (digest === this._sessionDigest) return;
    this._sessionDigest = digest;
    this.app.syncSessionIdentity?.(this._allSessions);
    this._updateBackendFilterBtn(document.getElementById('backend-filter'));
    this._renderBackendQuickTabs();
    this._renderAgentKindQuickTabs();
    this._render();
  }

  _render() {
    const f = (document.getElementById('session-filter')?.value || '').toLowerCase();
    let sessions = this._allSessions;

    // Text filter
    if (f) sessions = sessions.filter(s =>
      (s.cwd || '').toLowerCase().includes(f)
      || (s.sessionId || '').toLowerCase().includes(f)
      || (s.sessionKey || '').toLowerCase().includes(f)
      || (s.name || '').toLowerCase().includes(f)
      || (s.webuiName || '').toLowerCase().includes(f)
      || (s.backend || '').toLowerCase().includes(f)
      || (s.sourceKind || '').toLowerCase().includes(f)
      || (s.agentKind || '').toLowerCase().includes(f)
      || (s.agentRole || '').toLowerCase().includes(f)
      || (s.agentNickname || '').toLowerCase().includes(f)
    );

    // Backend / agent filter
    if (this._backendFilter.size > 0) {
      sessions = sessions.filter(s => this._backendFilter.has(s.backend || 'claude'));
    }
    if (this._agentKindFilter) {
      sessions = sessions.filter(s => (s.agentKind || 'primary') === this._agentKindFilter);
    }

    // Archive filter: hide archived sessions unless 'archived' filter is on
    const showArchived = this._statusFilter.has('archived');
    if (showArchived) {
      // When archived filter is on, show only archived (plus any other enabled statuses for non-archived)
      sessions = sessions.filter(s => {
        if (this._stateSetHas(this._archivedIds, s)) return true;
        return this._statusFilter.has(s.status);
      });
    } else {
      // Hide archived sessions, then apply status filter
      sessions = sessions.filter(s => !this._stateSetHas(this._archivedIds, s));
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
        const aStarred = a[1].some(s => this._stateSetHas(this._starredIds, s)) ? 1 : 0;
        const bStarred = b[1].some(s => this._stateSetHas(this._starredIds, s)) ? 1 : 0;
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
        this._showGroupChecklistPopover(linkBtn,
          (name) => (this._groupFolders[name] || []).includes(cwd),
          (name, checked, pop) => { if (checked) this._addFolderToGroup(cwd, name); else this._removeFolderFromGroup(cwd, name); pop.remove(); });
      };
      header.appendChild(linkBtn);

      header.onclick = (e) => {
        if (e.target.closest('.folder-add-btn')) return;
        this._toggleCollapse(group, cwd);
      };

      const sessionsDiv = document.createElement('div'); sessionsDiv.className = 'folder-sessions';
      // Starred first, then by time
      this._sortSessions(items);
      for (const s of items) { sessionsDiv.appendChild(this._buildSessionCard(s)); }

      group.append(header, sessionsDiv);
      this.listEl.appendChild(group);
    }
  }

  _renderByGroups(sessions) {
    const sessionById = new Map();
    for (const s of sessions) {
      sessionById.set(this._getSessionStateKey(s), s);
      if (s.sessionId) sessionById.set(s.sessionId, s);
      const legacyId = this._getLegacySessionId(s);
      if (legacyId) sessionById.set(legacyId, s);
    }

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
          const agentOpts = {
            backend: s.backend || 'claude',
            backendSessionId: s.backendSessionId || s.sessionId,
            agentKind: s.agentKind || 'primary',
            agentRole: s.agentRole || '',
            agentNickname: s.agentNickname || '',
            sourceKind: s.sourceKind || '',
            parentThreadId: s.parentThreadId || null,
          };
          if (s.status === 'stopped') {
            const customName = this.getCustomName(s);
            this.app.resumeSession(s.sessionId, s.cwd, customName || s.name, agentOpts);
          } else if (s.status === 'live' && s.webuiId) {
            this.app.attachSession(s.webuiId, s.webuiName || s.name, s.cwd, { mode: s.webuiMode, ...agentOpts });
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
          if (e.dataTransfer.types.includes('application/x-folder-path') || e.dataTransfer.types.includes('application/x-session-id') || e.dataTransfer.types.includes('application/x-session-key')) {
            e.preventDefault(); e.stopPropagation(); header.classList.add('drop-target');
          }
        });
        el.addEventListener('dragleave', (e) => {
          if (!groupEl.contains(e.relatedTarget)) header.classList.remove('drop-target');
        });
        el.addEventListener('drop', (e) => {
          e.preventDefault(); e.stopPropagation(); header.classList.remove('drop-target');
          const folderPath = e.dataTransfer.getData('application/x-folder-path');
          const sessionKey = e.dataTransfer.getData('application/x-session-key');
          const sessionId = e.dataTransfer.getData('application/x-session-id');
          if (folderPath) this._addFolderToGroup(folderPath, groupName);
          else if (sessionKey || sessionId) this._assignSessionToGroup(sessionKey || sessionId, groupName);
        });
      };
      _setupGroupDrop(groupEl);

      header.onclick = (e) => {
        if (e.target.closest('.folder-add-btn')) return;
        this._toggleCollapse(groupEl, collapseKey);
      };

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = 'folder-sessions';
      // Sort: starred first, then by time
      this._sortSessions(groupSessions);
      for (const s of groupSessions) sessionsDiv.appendChild(this._buildSessionCard(s));

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
    const ungrouped = sessions.filter(s => !assignedIds.has(this._getSessionStateKey(s)) && !assignedIds.has(s.sessionId));
    if (ungrouped.length > 0) {
      const groupEl = document.createElement('div');
      groupEl.className = 'folder-group';
      const collapseKey = 'group:__ungrouped__';
      if (this._collapsedFolders.has(collapseKey)) groupEl.classList.add('collapsed');

      const header = document.createElement('div');
      header.className = 'folder-header';
      header.innerHTML = `<span class="folder-chevron">\u25BC</span><span class="folder-path" style="direction:ltr;font-style:italic">Ungrouped</span><span class="folder-count">${ungrouped.length}</span>`;

      header.onclick = () => this._toggleCollapse(groupEl, collapseKey);

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = 'folder-sessions';
      this._sortSessions(ungrouped);
      for (const s of ungrouped) sessionsDiv.appendChild(this._buildSessionCard(s));

      groupEl.append(header, sessionsDiv);
      this.listEl.appendChild(groupEl);
    }
  }

  _buildSessionCard(s) {
    return renderSessionCard(s, {
      state: this,
      app: this.app,
      settings: this.app.settings,
      expandedCardId: this._expandedCardId,
      onExpandToggle: (id) => { this._expandedCardId = id; this._render(); },
      onRename: (session, originalName) => this.renameSession(session, originalName),
    });
  }

  _showGroupFoldersPopover(anchor, groupName) {
    const pop = createPopover(anchor, 'groups-popover');

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
  }

  _showGroupContextMenu(x, y, groupName) {
    showContextMenu(x, y, [
      { label: 'Rename', action: () => {
        const n = prompt('Rename group:', groupName);
        if (n && n.trim() && n.trim() !== groupName) this._renameGroup(groupName, n.trim());
      }},
      { label: 'Linked folders', action: () => {
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
    ]);
  }

  _assignSessionToGroup(sessionOrKey, groupName) {
    const stateKey = this._getSessionStateKey(sessionOrKey);
    if (!stateKey) return;
    if (!this._sessionGroups[groupName]) this._sessionGroups[groupName] = [];
    if (!this._sessionGroups[groupName].includes(stateKey)) {
      this._sessionGroups[groupName].push(stateKey);
    }
    const legacyId = this._getLegacySessionId(sessionOrKey);
    if (legacyId && legacyId !== stateKey) {
      this._sessionGroups[groupName] = this._sessionGroups[groupName].filter(id => id !== legacyId);
    }
    this._pushUserState();
    this._render();
  }

  _showGroupChecklistPopover(anchor, isCheckedFn, onToggleFn) {
    const pop = createPopover(anchor, 'groups-popover');

    const groupNames = this._getGroupNames();
    for (const name of groupNames) {
      const row = document.createElement('label');
      row.className = 'session-detail-group-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isCheckedFn(name);
      cb.onchange = (e) => { e.stopPropagation(); onToggleFn(name, cb.checked, pop); };
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
        onToggleFn(name.trim(), true, pop);
        pop.remove();
      }
    };
    pop.appendChild(createRow);
  }

}

installSidebarState(Sidebar);
export { Sidebar };
