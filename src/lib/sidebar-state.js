/**
 * Sidebar state management mixin — star/archive/rename/groups,
 * server sync, session key migration, localStorage cache.
 *
 * Installed on Sidebar.prototype via installSidebarState(Sidebar).
 * All methods use `this` (Sidebar instance context).
 */
import { getSessionKey } from './agent-meta.js';

export function installSidebarState(SidebarClass) {
  const proto = SidebarClass.prototype;

  // ── Server State Sync ──

  proto._fetchUserState = async function() {
    try {
      const res = await fetch('/api/user-state');
      if (res.ok) {
        const state = await res.json();
        this._applyServerState(state);
        this._render();
        this.app.updateTaskbar();
      }
    } catch {}
  };

  proto._writeUserStateToLocalStorage = function(state) {
    localStorage.setItem('starredSessions', JSON.stringify(state.starredSessions || []));
    localStorage.setItem('archivedSessions', JSON.stringify(state.archivedSessions || []));
    localStorage.setItem('sessionCustomNames', JSON.stringify(state.customNames || {}));
    localStorage.setItem('sessionModes', JSON.stringify(state.sessionModes || {}));
    localStorage.setItem('sessionGroups', JSON.stringify(state.sessionGroups || {}));
    localStorage.setItem('groupFolders', JSON.stringify(state.groupFolders || {}));
  };

  proto._getLegacySessionId = function(sessionOrKey, fallback = null) {
    if (sessionOrKey && typeof sessionOrKey === 'object') {
      if (typeof sessionOrKey.sessionKey === 'string' && sessionOrKey.sessionKey.includes(':')) {
        return sessionOrKey.sessionKey.split(':').slice(1).join(':') || '';
      }
      return sessionOrKey.sessionId || sessionOrKey.backendSessionId || sessionOrKey.claudeSessionId || sessionOrKey.webuiId || sessionOrKey.id || '';
    }
    if (typeof sessionOrKey === 'string' && !sessionOrKey.includes(':')) return sessionOrKey;
    if (fallback && typeof fallback === 'object') {
      return fallback.sessionId || fallback.backendSessionId || fallback.claudeSessionId || fallback.webuiId || fallback.id || '';
    }
    return '';
  };

  proto._lookupTransientSessionKey = function(rawKey, sessions = this._allSessions) {
    const key = String(rawKey || '');
    if (!key) return null;
    let backend = '', transientId = '';
    if (key.includes(':')) {
      const idx = key.indexOf(':');
      backend = key.slice(0, idx) || 'claude';
      transientId = key.slice(idx + 1);
    } else {
      transientId = key;
    }
    if (!transientId.startsWith('sess-')) return null;
    const match = (sessions || []).find((session) => {
      const sessionBackend = session.backend || 'claude';
      if (backend && sessionBackend !== backend) return false;
      return session.webuiId === transientId || session.id === transientId;
    });
    if (!match) return null;
    const nextKey = match.sessionKey || getSessionKey(match) || '';
    return nextKey && nextKey !== key ? nextKey : null;
  };

  proto._lookupLegacySessionKey = function(legacyId, sessions = this._allSessions) {
    if (!legacyId) return null;
    const transient = this._lookupTransientSessionKey(legacyId, sessions);
    if (transient) return transient;
    const matches = (sessions || []).filter((session) => {
      const ids = [session.sessionId, session.backendSessionId, session.claudeSessionId, session.webuiId, session.id, this._getLegacySessionId(session)].filter(Boolean);
      return ids.includes(legacyId);
    });
    if (matches.length !== 1) return null;
    return this._getSessionStateKey(matches[0]) || null;
  };

  proto._getSessionStateKey = function(sessionOrKey, fallback = null) {
    if (sessionOrKey && typeof sessionOrKey === 'object') {
      return sessionOrKey.sessionKey || getSessionKey(sessionOrKey) || this._getLegacySessionId(sessionOrKey);
    }
    const transient = this._lookupTransientSessionKey(sessionOrKey, fallback && typeof fallback === 'object' ? [fallback] : this._allSessions);
    if (transient) return transient;
    if (typeof sessionOrKey === 'string' && sessionOrKey.includes(':')) return sessionOrKey;
    const fallbackKey = fallback && typeof fallback === 'object' ? getSessionKey(fallback) : '';
    if (fallbackKey) return fallbackKey;
    return this._lookupLegacySessionKey(sessionOrKey) || String(sessionOrKey || '');
  };

  proto._stateSetHas = function(set, sessionOrKey, fallback = null) {
    const stateKey = this._getSessionStateKey(sessionOrKey, fallback);
    if (stateKey && set.has(stateKey)) return true;
    const legacyId = this._getLegacySessionId(sessionOrKey, fallback);
    return !!(legacyId && set.has(legacyId));
  };

  proto._stateMapGet = function(map, sessionOrKey, fallback = null) {
    const stateKey = this._getSessionStateKey(sessionOrKey, fallback);
    if (stateKey && Object.hasOwn(map, stateKey)) return map[stateKey];
    const legacyId = this._getLegacySessionId(sessionOrKey, fallback);
    if (legacyId && Object.hasOwn(map, legacyId)) return map[legacyId];
    return null;
  };

  proto._migrateStateArray = function(items, sessions = this._allSessions) {
    const next = [], seen = new Set();
    let changed = false;
    for (const raw of Array.isArray(items) ? items : []) {
      const mapped = this._lookupTransientSessionKey(raw, sessions)
        || ((typeof raw === 'string' && raw.includes(':')) ? raw : (this._lookupLegacySessionKey(raw, sessions) || raw));
      if (mapped !== raw) changed = true;
      if (seen.has(mapped)) { changed = true; continue; }
      seen.add(mapped);
      next.push(mapped);
    }
    return { next, changed };
  };

  proto._migrateStateMap = function(map, sessions = this._allSessions) {
    const next = {};
    let changed = false;
    for (const [rawKey, value] of Object.entries(map || {})) {
      const mappedKey = this._lookupTransientSessionKey(rawKey, sessions)
        || (rawKey.includes(':') ? rawKey : (this._lookupLegacySessionKey(rawKey, sessions) || rawKey));
      if (mappedKey !== rawKey) changed = true;
      if (!Object.hasOwn(next, mappedKey)) next[mappedKey] = value;
      else if (next[mappedKey] !== value) changed = true;
    }
    return { next, changed };
  };

  proto._migrateUserStateKeys = function(sessions = this._allSessions) {
    let changed = false;
    const starred = this._migrateStateArray([...this._starredIds], sessions);
    const archived = this._migrateStateArray([...this._archivedIds], sessions);
    const customNames = this._migrateStateMap(this._customNames, sessions);
    const sessionModes = this._migrateStateMap(this._sessionModes, sessions);
    const nextGroups = {};
    for (const [groupName, sessionKeys] of Object.entries(this._sessionGroups || {})) {
      const migrated = this._migrateStateArray(sessionKeys, sessions);
      nextGroups[groupName] = migrated.next;
      if (migrated.changed) changed = true;
    }
    if (starred.changed || archived.changed || customNames.changed || sessionModes.changed) changed = true;
    if (!changed) return false;
    this._starredIds = new Set(starred.next);
    this._archivedIds = new Set(archived.next);
    this._customNames = customNames.next;
    this._sessionModes = sessionModes.next;
    this._sessionGroups = nextGroups;
    this._writeUserStateToLocalStorage({
      starredSessions: [...this._starredIds], archivedSessions: [...this._archivedIds],
      customNames: this._customNames, sessionModes: this._sessionModes,
      sessionGroups: this._sessionGroups, groupFolders: this._groupFolders,
    });
    return true;
  };

  proto._applyServerState = function(state) {
    if (state.stateVersion) this._userStateVersion = state.stateVersion;
    if (state.starredSessions) this._starredIds = new Set(state.starredSessions);
    if (state.archivedSessions) this._archivedIds = new Set(state.archivedSessions);
    if (state.customNames) this._customNames = { ...state.customNames };
    if (state.sessionModes) this._sessionModes = { ...state.sessionModes };
    if (state.sessionGroups) this._sessionGroups = { ...state.sessionGroups };
    if (state.groupFolders) this._groupFolders = { ...state.groupFolders };
    this._writeUserStateToLocalStorage({
      starredSessions: [...this._starredIds], archivedSessions: [...this._archivedIds],
      customNames: this._customNames, sessionModes: this._sessionModes,
      sessionGroups: this._sessionGroups, groupFolders: this._groupFolders,
    });
  };

  proto._pushUserState = async function() {
    const state = {
      starredSessions: [...this._starredIds], archivedSessions: [...this._archivedIds],
      customNames: this._customNames, sessionModes: this._sessionModes,
      sessionGroups: this._sessionGroups, groupFolders: this._groupFolders,
    };
    this._writeUserStateToLocalStorage(state);
    try {
      await fetch('/api/user-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
    } catch {}
  };

  // ── Star / Archive / Rename ──

  proto._sortSessions = function(arr) {
    arr.sort((a, b) => {
      const as = this._stateSetHas(this._starredIds, a) ? 1 : 0;
      const bs = this._stateSetHas(this._starredIds, b) ? 1 : 0;
      if (as !== bs) return bs - as;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });
  };

  proto.toggleStar = function(sessionOrKey) {
    const stateKey = this._getSessionStateKey(sessionOrKey);
    if (this._stateSetHas(this._starredIds, sessionOrKey)) {
      this._starredIds.delete(stateKey);
      const legacyId = this._getLegacySessionId(sessionOrKey);
      if (legacyId) this._starredIds.delete(legacyId);
    } else if (stateKey) {
      this._starredIds.add(stateKey);
    }
    this._pushUserState(); this._render(); this.app.updateTaskbar();
  };

  proto.isStarred = function(sessionOrKey) { return this._stateSetHas(this._starredIds, sessionOrKey); };

  proto.toggleArchive = function(sessionOrKey) {
    const stateKey = this._getSessionStateKey(sessionOrKey);
    if (this._stateSetHas(this._archivedIds, sessionOrKey)) {
      this._archivedIds.delete(stateKey);
      const legacyId = this._getLegacySessionId(sessionOrKey);
      if (legacyId) this._archivedIds.delete(legacyId);
    } else if (stateKey) {
      this._archivedIds.add(stateKey);
    }
    this._pushUserState(); this._render(); this.app.updateTaskbar();
  };

  proto.isArchived = function(sessionOrKey) { return this._stateSetHas(this._archivedIds, sessionOrKey); };
  proto.getCustomName = function(sessionOrKey) { return this._stateMapGet(this._customNames, sessionOrKey); };
  proto.getSessionMode = function(sessionOrKey) { return this._stateMapGet(this._sessionModes, sessionOrKey); };

  proto.setSessionMode = function(sessionOrKey, mode) {
    const stateKey = this._getSessionStateKey(sessionOrKey);
    if (!stateKey) return;
    this._sessionModes[stateKey] = mode;
    const legacyId = this._getLegacySessionId(sessionOrKey);
    if (legacyId && legacyId !== stateKey) delete this._sessionModes[legacyId];
    this._pushUserState();
  };

  proto.renameSession = function(sessionOrKey, currentName) {
    const stateKey = this._getSessionStateKey(sessionOrKey);
    const name = prompt('Session name:', this.getCustomName(sessionOrKey) || currentName || '');
    if (name === null) return;
    if (!stateKey) return;
    if (name.trim()) this._customNames[stateKey] = name.trim();
    else delete this._customNames[stateKey];
    const legacyId = this._getLegacySessionId(sessionOrKey);
    if (legacyId && legacyId !== stateKey) delete this._customNames[legacyId];
    this._pushUserState(); this._render();
    const newName = name.trim() || currentName || (legacyId ? legacyId.substring(0, 12) + '...' : 'Session');
    if (sessionOrKey?.backend === 'codex' && name.trim()) this.app.renameBackendSession?.(sessionOrKey, name.trim());
    this.app.syncSessionName(sessionOrKey, newName);
  };

  // ── Session Groups ──

  proto._getGroupNames = function() { return Object.keys(this._sessionGroups).sort((a, b) => a.localeCompare(b)); };

  proto._getSessionGroups = function(sessionOrKey) {
    const stateKey = this._getSessionStateKey(sessionOrKey);
    const legacyId = this._getLegacySessionId(sessionOrKey);
    const groups = [];
    for (const [name, ids] of Object.entries(this._sessionGroups)) {
      if (ids.includes(stateKey) || (legacyId && ids.includes(legacyId))) groups.push(name);
    }
    return groups;
  };

  proto._addSessionToGroup = function(sessionOrKey, groupName) {
    const stateKey = this._getSessionStateKey(sessionOrKey);
    if (!stateKey) return;
    if (!this._sessionGroups[groupName]) this._sessionGroups[groupName] = [];
    if (!this._sessionGroups[groupName].includes(stateKey)) this._sessionGroups[groupName].push(stateKey);
    const legacyId = this._getLegacySessionId(sessionOrKey);
    if (legacyId && legacyId !== stateKey) this._sessionGroups[groupName] = this._sessionGroups[groupName].filter(id => id !== legacyId);
    this._pushUserState(); this._render();
  };

  proto._removeSessionFromGroup = function(sessionOrKey, groupName) {
    if (!this._sessionGroups[groupName]) return;
    const stateKey = this._getSessionStateKey(sessionOrKey);
    const legacyId = this._getLegacySessionId(sessionOrKey);
    this._sessionGroups[groupName] = this._sessionGroups[groupName].filter(id => id !== stateKey && id !== legacyId);
    if (this._sessionGroups[groupName].length === 0) delete this._sessionGroups[groupName];
    this._pushUserState(); this._render();
  };

  proto._addFolderToGroup = function(folderPath, groupName) {
    if (!this._groupFolders[groupName]) this._groupFolders[groupName] = [];
    if (!this._groupFolders[groupName].includes(folderPath)) {
      this._groupFolders[groupName].push(folderPath);
      this._pushUserState(); this._render();
    }
  };

  proto._removeFolderFromGroup = function(folderPath, groupName) {
    if (!this._groupFolders[groupName]) return;
    this._groupFolders[groupName] = this._groupFolders[groupName].filter(p => p !== folderPath);
    this._pushUserState(); this._render();
  };

  proto._getGroupSessions = function(groupName, allSessions) {
    const directIds = new Set(this._sessionGroups[groupName] || []);
    const folders = this._groupFolders[groupName] || [];
    const result = new Set(directIds);
    for (const s of allSessions) {
      const sessionKey = this._getSessionStateKey(s);
      if (result.has(sessionKey) || result.has(s.sessionId)) continue;
      const cwd = s.cwd || '';
      for (const fp of folders) {
        if (cwd === fp || cwd.startsWith(fp + '/')) { result.add(sessionKey); break; }
      }
    }
    return result;
  };

  proto._createGroup = function(name) {
    if (!name || this._sessionGroups[name]) return;
    this._sessionGroups[name] = [];
    this._pushUserState(); this._render();
  };

  proto._deleteGroup = function(name) {
    delete this._sessionGroups[name];
    delete this._groupFolders[name];
    this._pushUserState(); this._render();
  };

  proto._renameGroup = function(oldName, newName) {
    if (this._sessionGroups[newName]) return;
    this._sessionGroups[newName] = this._sessionGroups[oldName] || [];
    delete this._sessionGroups[oldName];
    if (this._groupFolders[oldName]) {
      this._groupFolders[newName] = this._groupFolders[oldName];
      delete this._groupFolders[oldName];
    }
    this._pushUserState(); this._render();
  };
}
