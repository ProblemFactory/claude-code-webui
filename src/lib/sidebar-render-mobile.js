/**
 * Sidebar mobile rendering mixin — two-level folder/group navigation.
 *
 * Level 1: folder or group list (tap to drill in)
 * Level 2: session cards inside one folder/group (back button to return)
 *
 * Installed on Sidebar.prototype via installSidebarRenderMobile(Sidebar).
 * Only active when app.isMobile is true.
 */
import { escHtml } from './utils.js';

const MOBILE_ICON_FOLDER = '<svg style="width:18px;height:18px;flex-shrink:0;vertical-align:-3px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h4l2 2h6v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"/></svg>';
const MOBILE_ICON_GROUP = '<svg style="width:18px;height:18px;flex-shrink:0;vertical-align:-3px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2.5"/><path d="M1 13c0-2.5 2-4 5-4s5 1.5 5 4"/><circle cx="11.5" cy="5.5" r="2"/><path d="M15 13c0-2 -1.5-3.2-3.5-3.5"/></svg>';

export function installSidebarRenderMobile(SidebarClass) {
  const proto = SidebarClass.prototype;

  proto._renderMobileFolderList = function(sessions) {
    const groups = new Map();
    for (const s of sessions) {
      const key = s.cwd || '/unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    let entries = [...groups.entries()];
    entries.sort((a, b) => {
      const aStarred = a[1].some(s => this._stateSetHas(this._starredIds, s)) ? 1 : 0;
      const bStarred = b[1].some(s => this._stateSetHas(this._starredIds, s)) ? 1 : 0;
      if (aStarred !== bStarred) return bStarred - aStarred;
      const aMax = Math.max(...a[1].map(s => s.startedAt || 0));
      const bMax = Math.max(...b[1].map(s => s.startedAt || 0));
      return bMax - aMax;
    });
    for (const [cwd, items] of entries) {
      const cwdShort = cwd.replace(/^\/home\/[^/]+/, '~');
      const liveCount = items.filter(s => s.status === 'live' || s.status === 'tmux').length;
      const card = document.createElement('div'); card.className = 'mobile-folder-card';
      const lastSlash = cwdShort.lastIndexOf('/');
      const pathHead = lastSlash > 0 ? cwdShort.slice(0, lastSlash + 1) : '';
      const pathTail = lastSlash > 0 ? cwdShort.slice(lastSlash + 1) : cwdShort;
      card.innerHTML = MOBILE_ICON_FOLDER
        + `<span class="mobile-folder-path"><span class="mobile-folder-path-head">${escHtml(pathHead)}</span><span class="mobile-folder-path-tail">${escHtml(pathTail)}</span></span>`
        + `<span class="mobile-folder-meta">${items.length} session${items.length > 1 ? 's' : ''}${liveCount ? ' · ' + liveCount + ' live' : ''}</span>`
        + `<span class="mobile-folder-arrow">\u203A</span>`;
      if (liveCount) card.classList.add('has-live');
      card.onclick = () => { this._mobileDrilldown = { type: 'folder', key: cwd, label: cwdShort }; this._renderMobileFolderDetail(cwd, cwdShort, items, sessions); };
      this.listEl.appendChild(card);
    }
  };

  proto._renderMobileFolderDetail = function(cwd, cwdShort, items, allSessions) {
    this.listEl.innerHTML = '';
    const back = document.createElement('div'); back.className = 'mobile-folder-back';
    back.innerHTML = `<span class="mobile-folder-back-arrow">\u2039</span> <span>All Folders</span>`;
    back.onclick = () => { this._mobileDrilldown = null; this.listEl.innerHTML = ''; this._renderMobileFolderList(allSessions); };
    this.listEl.appendChild(back);
    const titleRow = document.createElement('div'); titleRow.className = 'mobile-folder-title';
    titleRow.innerHTML = `<span>${escHtml(cwdShort)}</span>`;
    const addBtn = document.createElement('button'); addBtn.className = 'folder-add-btn'; addBtn.textContent = '+';
    addBtn.onclick = (e) => { e.stopPropagation(); this.app.showNewSessionDialog({ cwd }); };
    titleRow.appendChild(addBtn);
    this.listEl.appendChild(titleRow);
    this._sortSessions(items);
    for (const s of items) this.listEl.appendChild(this._buildSessionCard(s));
  };

  proto._renderMobileGroupList = function(sessions) {
    const groupNames = this._getGroupNames();
    const sessionById = new Map();
    for (const s of sessions) {
      sessionById.set(this._getSessionStateKey(s), s);
      sessionById.set(s.sessionId, s);
    }
    const assignedIds = new Set();
    for (const groupName of groupNames) {
      const groupSessionIds = this._getGroupSessions(groupName, sessions);
      const groupSessions = [...groupSessionIds].map(id => sessionById.get(id)).filter(Boolean);
      groupSessionIds.forEach(id => assignedIds.add(id));
      const liveCount = groupSessions.filter(s => s.status === 'live' || s.status === 'tmux').length;
      const card = document.createElement('div'); card.className = 'mobile-folder-card';
      card.innerHTML = MOBILE_ICON_GROUP
        + `<span class="mobile-folder-path">${escHtml(groupName)}</span>`
        + `<span class="mobile-folder-meta">${groupSessions.length} session${groupSessions.length > 1 ? 's' : ''}${liveCount ? ' · ' + liveCount + ' live' : ''}</span>`
        + `<span class="mobile-folder-arrow">\u203A</span>`;
      if (liveCount) card.classList.add('has-live');
      card.onclick = () => { this._mobileDrilldown = { type: 'group', key: groupName }; this._renderMobileGroupDetail(groupName, groupSessions, sessions); };
      this.listEl.appendChild(card);
    }
    const ungrouped = sessions.filter(s => !assignedIds.has(this._getSessionStateKey(s)) && !assignedIds.has(s.sessionId));
    if (ungrouped.length > 0) {
      const card = document.createElement('div'); card.className = 'mobile-folder-card';
      card.innerHTML = MOBILE_ICON_GROUP
        + `<span class="mobile-folder-path" style="font-style:italic">Ungrouped</span>`
        + `<span class="mobile-folder-meta">${ungrouped.length} sessions</span>`
        + `<span class="mobile-folder-arrow">\u203A</span>`;
      card.onclick = () => { this._mobileDrilldown = { type: 'group', key: '__ungrouped__' }; this._renderMobileGroupDetail('Ungrouped', ungrouped, sessions); };
      this.listEl.appendChild(card);
    }
  };

  proto._renderMobileGroupDetail = function(groupName, groupSessions, allSessions) {
    this.listEl.innerHTML = '';
    const back = document.createElement('div'); back.className = 'mobile-folder-back';
    back.innerHTML = `<span class="mobile-folder-back-arrow">\u2039</span> <span>All Groups</span>`;
    back.onclick = () => { this._mobileDrilldown = null; this.listEl.innerHTML = ''; this._renderMobileGroupList(allSessions); };
    this.listEl.appendChild(back);
    const titleRow = document.createElement('div'); titleRow.className = 'mobile-folder-title';
    titleRow.innerHTML = `<span>${escHtml(groupName)}</span>`;
    this.listEl.appendChild(titleRow);
    this._sortSessions(groupSessions);
    for (const s of groupSessions) this.listEl.appendChild(this._buildSessionCard(s));
  };
}
