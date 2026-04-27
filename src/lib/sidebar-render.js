/**
 * Sidebar rendering mixin — folder-grouped and user-grouped session lists,
 * group context menus, folder linking, drag-drop.
 *
 * Installed on Sidebar.prototype via installSidebarRender(Sidebar).
 */
import { escHtml, createPopover, showContextMenu } from './utils.js';
import { createBackendIcon, getBackendMeta, getSessionKey } from './agent-meta.js';
import { renderSessionCard } from './session-card.js';

export function installSidebarRender(SidebarClass) {
  const proto = SidebarClass.prototype;

  // Lazy render/unload folder contents based on viewport visibility.
  // Each folder group starts empty; IntersectionObserver triggers render
  // when the group enters viewport, and replaces with a height placeholder
  // when it scrolls far away — keeping DOM node count low.
  proto._setupLazyFolders = function() {
    if (this._folderObserver) this._folderObserver.disconnect();
    const scrollRoot = this.listEl.closest('.sidebar-section');
    this._folderObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const group = entry.target;
        const sessionsDiv = group.querySelector('.folder-sessions');
        if (!sessionsDiv) continue;
        if (entry.isIntersecting) {
          // Entering viewport — render cards if placeholder
          if (sessionsDiv.dataset.lazy === 'placeholder') {
            const items = sessionsDiv._lazyItems;
            if (items) {
              sessionsDiv.innerHTML = '';
              for (const s of items) sessionsDiv.appendChild(this._buildSessionCard(s));
              sessionsDiv.dataset.lazy = 'rendered';
            }
          }
        } else {
          // Leaving viewport — replace cards with height placeholder
          if (sessionsDiv.dataset.lazy === 'rendered' && sessionsDiv.children.length > 0) {
            const h = sessionsDiv.offsetHeight;
            sessionsDiv.innerHTML = '';
            sessionsDiv.style.minHeight = h + 'px';
            sessionsDiv.dataset.lazy = 'placeholder';
          }
        }
      }
    }, { root: scrollRoot, rootMargin: '200px 0px' });
  };

  proto._observeFolder = function(group, sessionsDiv, items) {
    // Store items for lazy re-render
    sessionsDiv._lazyItems = items;
    sessionsDiv.dataset.lazy = 'pending';
    if (this._folderObserver) this._folderObserver.observe(group);
  };

  proto._renderGrouped = function(sessions) {
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

      const addBtn = document.createElement('button'); addBtn.className = 'folder-add-btn';
      addBtn.textContent = '+'; addBtn.title = 'New session in ' + cwdShort;
      addBtn.onclick = (e) => { e.stopPropagation(); this.app.showNewSessionDialog({ cwd }); };
      header.appendChild(addBtn);

      const linkBtn = document.createElement('button'); linkBtn.className = 'folder-add-btn';
      linkBtn.innerHTML = '<svg style="width:10px;height:10px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 9l2-2M6 12l-1.5 1.5a2 2 0 01-3-3L4 8M10 4l1.5-1.5a2 2 0 013 3L12 8"/></svg>'; linkBtn.title = 'Add folder to group';
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
      this._sortSessions(items);

      group.append(header, sessionsDiv);
      this.listEl.appendChild(group);
      // Defer card rendering to IntersectionObserver
      this._observeFolder(group, sessionsDiv, items);
    }
    this._setupLazyFolders();
    // Trigger initial check for folders already in viewport
    requestAnimationFrame(() => {
      if (!this._folderObserver) return;
      for (const group of this.listEl.querySelectorAll('.folder-group')) {
        const sessionsDiv = group.querySelector('.folder-sessions');
        if (sessionsDiv?.dataset.lazy === 'pending') {
          const rect = group.getBoundingClientRect();
          const scrollRoot = this.listEl.closest('.sidebar-section');
          const rootRect = scrollRoot?.getBoundingClientRect() || { top: 0, bottom: window.innerHeight };
          if (rect.top < rootRect.bottom + 200 && rect.bottom > rootRect.top - 200) {
            const items = sessionsDiv._lazyItems;
            if (items) {
              for (const s of items) sessionsDiv.appendChild(this._buildSessionCard(s));
              sessionsDiv.dataset.lazy = 'rendered';
            }
          }
        }
      }
    });
  };

  proto._renderByGroups = function(sessions) {
    const sessionById = new Map();
    for (const s of sessions) {
      sessionById.set(this._getSessionStateKey(s), s);
      if (s.sessionId) sessionById.set(s.sessionId, s);
      const legacyId = this._getLegacySessionId(s);
      if (legacyId) sessionById.set(legacyId, s);
    }

    const groupNames = this._getGroupNames();
    const assignedIds = new Set();

    const addGroupCard = document.createElement('div');
    addGroupCard.className = 'session-item-card new-session-card';
    addGroupCard.innerHTML = '<div class="session-card-name" style="color:var(--accent-hover)">+ New Group</div>';
    addGroupCard.onclick = () => {
      const name = prompt('Group name:');
      if (name && name.trim()) this._createGroup(name.trim());
    };
    this.listEl.appendChild(addGroupCard);

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

      const nameSpan = header.querySelector('.folder-path');
      if (nameSpan) {
        nameSpan.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          const newName = prompt('Rename group:', groupName);
          if (newName && newName.trim() && newName.trim() !== groupName) this._renameGroup(groupName, newName.trim());
        });
        nameSpan.title = 'Double-click to rename';
      }

      const resumeAllBtn = document.createElement('button');
      resumeAllBtn.className = 'folder-add-btn';
      resumeAllBtn.textContent = '\u25B6';
      resumeAllBtn.title = 'Resume all sessions in "' + groupName + '"';
      resumeAllBtn.onclick = (e) => {
        e.stopPropagation();
        for (const s of groupSessions) {
          const agentOpts = {
            backend: s.backend || 'claude', backendSessionId: s.backendSessionId || s.sessionId,
            agentKind: s.agentKind || 'primary', agentRole: s.agentRole || '',
            agentNickname: s.agentNickname || '', sourceKind: s.sourceKind || '',
            parentThreadId: s.parentThreadId || null,
          };
          if (s.status === 'stopped') {
            this.app.resumeSession(s.sessionId, s.cwd, this.getCustomName(s) || s.name, agentOpts);
          } else if (s.status === 'live' && s.webuiId) {
            this.app.attachSession(s.webuiId, s.webuiName || s.name, s.cwd, { mode: s.webuiMode, ...agentOpts });
          } else if (s.status === 'tmux') {
            this.app.attachTmuxSession(s.tmuxTarget, s.name, s.cwd);
          }
        }
      };
      header.appendChild(resumeAllBtn);

      header.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        this._showGroupContextMenu(e.clientX, e.clientY, groupName);
      });

      const _setupGroupDrop = (el) => {
        el.addEventListener('dragover', (e) => {
          if (e.dataTransfer.types.includes('application/x-folder-path') || e.dataTransfer.types.includes('application/x-session-id') || e.dataTransfer.types.includes('application/x-session-key')) {
            e.preventDefault(); e.stopPropagation(); header.classList.add('drop-target');
          }
        });
        el.addEventListener('dragleave', (e) => { if (!groupEl.contains(e.relatedTarget)) header.classList.remove('drop-target'); });
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
      this._sortSessions(groupSessions);

      if (groupSessions.length === 0) {
        const empty = document.createElement('div'); empty.className = 'empty-hint';
        empty.textContent = 'No sessions in this group';
        sessionsDiv.appendChild(empty);
      } else {
        this._observeFolder(groupEl, sessionsDiv, groupSessions);
      }

      groupEl.append(header, sessionsDiv);
      this.listEl.appendChild(groupEl);
    }

    // Ungrouped
    const ungrouped = sessions.filter(s => !assignedIds.has(this._getSessionStateKey(s)) && !assignedIds.has(s.sessionId));
    if (ungrouped.length > 0) {
      const groupEl = document.createElement('div'); groupEl.className = 'folder-group';
      const collapseKey = 'group:__ungrouped__';
      if (this._collapsedFolders.has(collapseKey)) groupEl.classList.add('collapsed');
      const header = document.createElement('div'); header.className = 'folder-header';
      header.innerHTML = `<span class="folder-chevron">\u25BC</span><span class="folder-path" style="direction:ltr;font-style:italic">Ungrouped</span><span class="folder-count">${ungrouped.length}</span>`;
      header.onclick = () => this._toggleCollapse(groupEl, collapseKey);
      const sessionsDiv = document.createElement('div'); sessionsDiv.className = 'folder-sessions';
      this._sortSessions(ungrouped);
      this._observeFolder(groupEl, sessionsDiv, ungrouped);
      groupEl.append(header, sessionsDiv);
      this.listEl.appendChild(groupEl);
    }
    this._setupLazyFolders();
  };

  proto._buildSessionCard = function(s) {
    return renderSessionCard(s, {
      state: this, app: this.app, settings: this.app.settings,
      expandedCardId: this._expandedCardId,
      onExpandToggle: (id) => { this._expandedCardId = id; this._render(); },
      onRename: (session, originalName) => this.renameSession(session, originalName),
    });
  };

  proto._showGroupFoldersPopover = function(anchor, groupName) {
    const pop = createPopover(anchor, 'groups-popover');
    const folders = this._groupFolders[groupName] || [];
    if (folders.length === 0) {
      const hint = document.createElement('div'); hint.className = 'empty-hint';
      hint.textContent = 'No linked folders. Use \uD83D\uDD17 on folder headers in Folders tab, or drag folders here.';
      pop.appendChild(hint);
    } else {
      for (const fp of folders) {
        const row = document.createElement('div'); row.className = 'session-detail-group-item';
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 8px;cursor:default';
        const pathSpan = document.createElement('span');
        pathSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px';
        pathSpan.textContent = fp.replace(/^\/home\/[^/]+/, '~'); pathSpan.title = fp;
        const removeBtn = document.createElement('button');
        removeBtn.style.cssText = 'background:none;border:none;color:var(--red,#e55);cursor:pointer;font-size:12px;padding:0 4px;flex-shrink:0';
        removeBtn.textContent = '\u00D7'; removeBtn.title = 'Unlink folder';
        removeBtn.onclick = (e) => { e.stopPropagation(); this._removeFolderFromGroup(fp, groupName); pop.remove(); };
        row.append(pathSpan, removeBtn);
        pop.appendChild(row);
      }
    }
  };

  proto._showGroupContextMenu = function(x, y, groupName) {
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
  };

  proto._assignSessionToGroup = function(sessionOrKey, groupName) {
    const stateKey = this._getSessionStateKey(sessionOrKey);
    if (!stateKey) return;
    if (!this._sessionGroups[groupName]) this._sessionGroups[groupName] = [];
    if (!this._sessionGroups[groupName].includes(stateKey)) this._sessionGroups[groupName].push(stateKey);
    const legacyId = this._getLegacySessionId(sessionOrKey);
    if (legacyId && legacyId !== stateKey) this._sessionGroups[groupName] = this._sessionGroups[groupName].filter(id => id !== legacyId);
    this._pushUserState(); this._render();
  };

  proto._showGroupChecklistPopover = function(anchor, isCheckedFn, onToggleFn) {
    const pop = createPopover(anchor, 'groups-popover');
    const groupNames = this._getGroupNames();
    for (const name of groupNames) {
      const row = document.createElement('label'); row.className = 'session-detail-group-item';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = isCheckedFn(name);
      cb.onchange = (e) => { e.stopPropagation(); onToggleFn(name, cb.checked, pop); };
      const lbl = document.createElement('span'); lbl.textContent = name;
      row.append(cb, lbl);
      row.onclick = (e) => e.stopPropagation();
      pop.appendChild(row);
    }
    if (groupNames.length === 0) {
      const hint = document.createElement('div'); hint.className = 'empty-hint'; hint.textContent = 'No groups yet';
      pop.appendChild(hint);
    }
    const createRow = document.createElement('div'); createRow.className = 'session-detail-group-create';
    createRow.textContent = '+ New group';
    createRow.onclick = (e) => {
      e.stopPropagation();
      const name = prompt('New group name:');
      if (name && name.trim()) { this._createGroup(name.trim()); onToggleFn(name.trim(), true, pop); pop.remove(); }
    };
    pop.appendChild(createRow);
  };
}
