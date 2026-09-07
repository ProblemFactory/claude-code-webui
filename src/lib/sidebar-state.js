/**
 * Sidebar state management mixin — star/archive/rename/groups,
 * server sync, session key migration, localStorage cache.
 *
 * Installed on Sidebar.prototype via installSidebarState(Sidebar).
 * All methods use `this` (Sidebar instance context).
 */
import { getSessionKey, backendFeatureCaps } from './agent-meta.js';
import { showToast, showInputDialog } from './utils.js';
import { t as tr } from './i18n.js';

export function installSidebarState(SidebarClass) {
  const proto = SidebarClass.prototype;

  // ── Server State Sync ──

  proto._fetchUserState = async function() {
    // Retry on failure (2.223.4, userW incident): this used to be a
    // ONE-SHOT fetch — a tab loading during a server-restart window came up
    // with names/stars/archives ALL unapplied (renames "gone", archived
    // sessions resurfacing) and never healed. Worse, _userStateFetched was
    // set even on failure, so a later star/rename POSTed the EMPTY full doc
    // back over the server's real state (silent fleet-wide clobber bomb).
    // Now: retries with backoff, the fetched flag is set only after a
    // SUCCESSFUL apply (writes stay blocked until then), and the app's
    // reconnect path calls this again (idempotent).
    for (const wait of [0, 2000, 5000, 15000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        const res = await fetch('/api/user-state');
        if (!res.ok) continue;
        const state = await res.json();
        this._applyServerState(state);
        this._render();
        this.app.updateTaskbar();
        // Only after the authoritative server state has been applied may
        // migration-triggered pushes write back (see _migrateUserStateKeys).
        this._userStateFetched = true;
        return;
      } catch {}
    }
    console.warn('[user-state] initial fetch failed after retries — stars/names read-only until reconnect');
  };

  proto._writeUserStateToLocalStorage = function(state) {
    localStorage.setItem('starredSessions', JSON.stringify(state.starredSessions || []));
    localStorage.setItem('archivedSessions', JSON.stringify(state.archivedSessions || []));
    localStorage.setItem('archivedFolders', JSON.stringify(state.archivedFolders || []));
    localStorage.setItem('sessionCustomNames', JSON.stringify(state.customNames || {}));
    localStorage.setItem('sessionModes', JSON.stringify(state.sessionModes || {}));
    localStorage.setItem('sessionConfigs', JSON.stringify(state.sessionConfigs || {}));
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
      else if (next[mappedKey] !== value) {
        // TWO raw keys mapped onto ONE session with DIFFERENT values — one of
        // them is about to be DROPPED silently. That is how a session ends up
        // wearing another session's custom name (and how the rightful owner
        // loses its own): user-visible state disappearing with no trace.
        // Never silent again — breadcrumb + telemetry so a recurrence is
        // provable from an incident bundle (2026-08-11 field report).
        try { window.__vsOp?.('state-key-collision', { key: String(mappedKey).slice(0, 40), kept: String(next[mappedKey]).slice(0, 30), dropped: String(value).slice(0, 30) }); } catch {}
        try { window.__vsTelemetry?.event?.('state-key-collision'); } catch {}
        changed = true;
      }
    }
    return { next, changed };
  };

  proto._migrateUserStateKeys = function(sessions = this._allSessions) {
    let changed = false;
    const starred = this._migrateStateArray([...this._starredIds], sessions);
    const archived = this._migrateStateArray([...this._archivedIds], sessions);
    const customNames = this._migrateStateMap(this._customNames, sessions);
    const sessionModes = this._migrateStateMap(this._sessionModes, sessions);
    const sessionConfigs = this._migrateStateMap(this._sessionConfigs, sessions);
    const nextGroups = {};
    for (const [groupName, sessionKeys] of Object.entries(this._sessionGroups || {})) {
      const migrated = this._migrateStateArray(sessionKeys, sessions);
      nextGroups[groupName] = migrated.next;
      if (migrated.changed) changed = true;
    }
    if (starred.changed || archived.changed || customNames.changed || sessionModes.changed || sessionConfigs.changed) changed = true;
    if (!changed) return false;
    this._starredIds = new Set(starred.next);
    this._archivedIds = new Set(archived.next);
    this._customNames = customNames.next;
    this._sessionModes = sessionModes.next;
    this._sessionConfigs = sessionConfigs.next;
    this._sessionGroups = nextGroups;
    this._writeUserStateToLocalStorage({
      starredSessions: [...this._starredIds], archivedSessions: [...this._archivedIds],
      archivedFolders: [...(this._archivedFolders || [])],
      customNames: this._customNames, sessionModes: this._sessionModes, sessionConfigs: this._sessionConfigs,
      sessionGroups: this._sessionGroups, groupFolders: this._groupFolders,
    });
    return true;
  };

  proto._applyServerState = function(state) {
    if (state.starredSessions) this._starredIds = new Set(state.starredSessions);
    if (state.archivedSessions) this._archivedIds = new Set(state.archivedSessions);
    if (state.archivedFolders) this._archivedFolders = new Set(state.archivedFolders);
    if (state.customNames) this._customNames = { ...state.customNames };
    if (state.sessionModes) this._sessionModes = { ...state.sessionModes };
    if (state.sessionConfigs) this._sessionConfigs = { ...state.sessionConfigs };
    if (state.sessionGroups) this._sessionGroups = { ...state.sessionGroups };
    if (state.groupFolders) this._groupFolders = { ...state.groupFolders };
    // snapshot what the SERVER said — _pushUserState diffs against it so a
    // stale tab can only ever send the keys it actually changed (B-b87b)
    this._serverStateJson = {};
    for (const k of ['starredSessions', 'archivedSessions', 'archivedFolders', 'customNames', 'sessionModes', 'sessionConfigs', 'sessionGroups', 'groupFolders']) {
      if (state[k] !== undefined) this._serverStateJson[k] = JSON.stringify(state[k]);
    }
    this._writeUserStateToLocalStorage({
      starredSessions: [...this._starredIds], archivedSessions: [...this._archivedIds],
      archivedFolders: [...(this._archivedFolders || [])],
      customNames: this._customNames, sessionModes: this._sessionModes, sessionConfigs: this._sessionConfigs,
      sessionGroups: this._sessionGroups, groupFolders: this._groupFolders,
    });
  };

  proto._pushUserState = async function() {
    const state = {
      starredSessions: [...this._starredIds], archivedSessions: [...this._archivedIds],
      archivedFolders: [...(this._archivedFolders || [])],
      customNames: this._customNames, sessionModes: this._sessionModes, sessionConfigs: this._sessionConfigs,
      sessionGroups: this._sessionGroups, groupFolders: this._groupFolders,
    };
    this._writeUserStateToLocalStorage(state);
    // CLOBBER BELT (B-b87b): the full-doc POST let a tab acting on a STALE
    // mirror (open all day, missed broadcasts) silently revert every key it
    // never touched — stars/renames/configs made in other tabs vanished. Diff
    // against the last server-applied snapshot and PATCH only the changed
    // top-level keys; unchanged keys can't travel, so stale damage is bounded
    // to the key actually edited. No snapshot yet (pre-first-fetch legacy
    // path) → full POST as before.
    try {
      const snap = this._serverStateJson;
      if (snap) {
        const delta = {};
        for (const [k, v] of Object.entries(state)) {
          if (snap[k] !== JSON.stringify(v)) delta[k] = v;
        }
        if (!Object.keys(delta).length) return;
        await fetch('/api/user-state', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(delta) });
        return;
      }
      await fetch('/api/user-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
    } catch {}
  };

  // ── Star / Archive / Rename ──

  // Waiting-key set (OSC-idle sessions), cached for one synchronous render pass
  // so a card grid + its sort don't each re-scan every window.
  proto._waitingSet = function() {
    if (this.__waitingCache) return this.__waitingCache;
    const w = this.app?.getWaitingSessionKeys?.() || new Set();
    this.__waitingCache = w;
    try { queueMicrotask(() => { this.__waitingCache = null; }); } catch { this.__waitingCache = null; }
    return w;
  };

  // Urgency + attention rank for a session (higher floats to the top). The
  // agent sets urgency via vibespace-status; blocked/needs-input/OSC-waiting
  // also bump it so sessions that need you surface without an explicit urgency.
  proto._sessionSortRank = function(s, waiting) {
    const URG = { urgent: 3, high: 2, normal: 1, low: 0 };
    const st = this.getSessionStatus?.(s);
    const isLive = s.status === 'live' || s.status === 'tmux';
    // Finished work sinks below everything — done is a result, not a demand.
    if (st?.state === 'done') return -1;
    let r = st?.urgency ? (URG[st.urgency] ?? 0) : 0;
    // Attention bumps only for RUNNING sessions — a stopped session's stale
    // blocked/needs-input declaration describes a process that no longer runs.
    if (isLive && st?.state === 'blocked') r = Math.max(r, 2);
    else if (isLive && st?.state === 'needs-input') r = Math.max(r, 1);
    const key = `${s.backend || 'claude'}:${s.backendSessionId || s.claudeSessionId || ''}`;
    if (waiting.has(key)) r = Math.max(r, 1);
    return r;
  };

  proto._sortSessions = function(arr) {
    const waiting = this._waitingSet();
    const rankOf = new Map();
    for (const s of arr) rankOf.set(s, this._sessionSortRank(s, waiting));
    arr.sort((a, b) => {
      const ar = rankOf.get(a), br = rankOf.get(b);
      if (ar !== br) return br - ar; // urgency/attention first (user: 决定排列优先级)
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
      // If its folder is still folder-archived the session would just re-archive
      // on the next render — dissolve the folder rule into individual archives
      // (minus this session) so unarchiving one card actually sticks.
      this._dissolveFolderArchive(sessionOrKey, stateKey);
    } else if (this._isFolderArchived(sessionOrKey)) {
      // Archived only via the folder rule (e.g. created after Archive project):
      // unarchive = dissolve the rule, keep the rest archived individually.
      this._dissolveFolderArchive(sessionOrKey, stateKey);
    } else if (stateKey) {
      this._archivedIds.add(stateKey);
    }
    this._pushUserState(); this._render(); this.app.updateTaskbar();
  };

  // Folder-level archive key for a session — host-scoped so archiving a local
  // folder never swallows a remote session that happens to share the path.
  proto._archiveFolderKey = function(sessionOrKey, host) {
    if (sessionOrKey && typeof sessionOrKey === 'object') {
      const cwd = sessionOrKey.cwd || '(unknown)';
      return (sessionOrKey.host ? sessionOrKey.host + '::' : '') + cwd;
    }
    if (typeof sessionOrKey === 'string' && sessionOrKey) return (host ? host + '::' : '') + sessionOrKey;
    return null;
  };

  proto._isFolderArchived = function(sessionOrKey) {
    const fkey = this._archiveFolderKey(sessionOrKey);
    return !!(fkey && this._archivedFolders?.has(fkey));
  };

  proto._dissolveFolderArchive = function(sessionOrKey, exceptKey) {
    const fkey = this._archiveFolderKey(sessionOrKey);
    if (!fkey || !this._archivedFolders?.has(fkey)) return;
    this._archivedFolders.delete(fkey);
    for (const s of this._allSessions || []) {
      if (this._archiveFolderKey(s) !== fkey) continue;
      const k = this._getSessionStateKey(s);
      if (k && k !== exceptKey) this._archivedIds.add(k);
    }
  };

  // A session is archived when explicitly archived OR its folder is archived.
  // The folder rule is what makes "Archive project" cover FUTURE sessions in
  // that folder too (previously only then-existing sessions were archived, so
  // new ones popped back and the archive looked like it didn't stick).
  proto.isArchived = function(sessionOrKey) {
    if (this._stateSetHas(this._archivedIds, sessionOrKey)) return true;
    return this._isFolderArchived(sessionOrKey);
  };

  proto.isFolderArchived = function(cwd, host) { return !!this._archivedFolders?.has(this._archiveFolderKey(cwd, host)); };

  // Archive a whole project: record the FOLDER (future sessions start archived)
  // + archive every current session under it individually.
  proto.archiveProject = function(cwd, sessions, host) {
    const fkey = this._archiveFolderKey(cwd, host);
    if (fkey) this._archivedFolders.add(fkey);
    let n = 0;
    for (const s of sessions || []) {
      const stateKey = this._getSessionStateKey(s);
      if (stateKey && !this._archivedIds.has(stateKey)) { this._archivedIds.add(stateKey); n++; }
    }
    this._pushUserState(); this._render(); this.app.updateTaskbar();
    showToast(tr('Archived {n} sessions — new sessions here start archived', { n }));
  };

  proto.unarchiveProject = function(cwd, host) {
    const fkey = this._archiveFolderKey(cwd, host);
    if (fkey) this._archivedFolders.delete(fkey);
    let n = 0;
    for (const s of this._allSessions || []) {
      if (this._archiveFolderKey(s) !== fkey) continue;
      const k = this._getSessionStateKey(s);
      if (k && this._archivedIds.delete(k)) n++;
      const legacy = this._getLegacySessionId(s);
      if (legacy) this._archivedIds.delete(legacy);
    }
    this._pushUserState(); this._render(); this.app.updateTaskbar();
    showToast(tr('Unarchived project ({n} sessions)', { n }));
  };

  // Bulk archive (folder header context menu) — one state push + render for
  // the whole batch instead of per-session toggles.
  proto.archiveSessions = function(sessions) {
    let n = 0;
    for (const s of sessions || []) {
      const stateKey = this._getSessionStateKey(s);
      if (stateKey && !this._archivedIds.has(stateKey)) { this._archivedIds.add(stateKey); n++; }
    }
    if (!n) return;
    this._pushUserState(); this._render(); this.app.updateTaskbar();
    showToast(tr('Archived {n} sessions', { n }));
  };

  proto.getCustomName = function(sessionOrKey) { return this._stateMapGet(this._customNames, sessionOrKey); };

  // Programmatic custom-name setter (no prompt) — used e.g. to persist a fork's
  // chosen title once its session id is known. Mirrors renameSession's persist
  // + broadcast + open-window title sync.
  proto.setCustomName = function(sessionOrKey, name) {
    const stateKey = this._getSessionStateKey(sessionOrKey);
    if (!stateKey) return;
    const trimmed = (name || '').trim();
    if (trimmed) this._customNames[stateKey] = trimmed;
    else delete this._customNames[stateKey];
    const legacyId = this._getLegacySessionId(sessionOrKey);
    if (legacyId && legacyId !== stateKey) delete this._customNames[legacyId];
    this._pushUserState(); this._render();
    if (trimmed) this.app.syncSessionName?.(sessionOrKey, trimmed);
  };
  proto.getSessionMode = function(sessionOrKey) { return this._stateMapGet(this._sessionModes, sessionOrKey); };

  proto.setSessionMode = function(sessionOrKey, mode) {
    const stateKey = this._getSessionStateKey(sessionOrKey);
    if (!stateKey) return;
    this._sessionModes[stateKey] = mode;
    const legacyId = this._getLegacySessionId(sessionOrKey);
    if (legacyId && legacyId !== stateKey) delete this._sessionModes[legacyId];
    this._pushUserState();
  };

  // Per-session parameter overrides: { model, effort, permission, account }
  // (only non-empty keys stored)
  proto.getSessionConfig = function(sessionOrKey) { return this._stateMapGet(this._sessionConfigs, sessionOrKey); };

  proto.setSessionConfig = function(sessionOrKey, config) {
    const stateKey = this._getSessionStateKey(sessionOrKey);
    if (!stateKey) return;
    const clean = {};
    // NOTE: this whitelist silently dropped 'account' when it was added in
    // 2.43.0 (the gear's Account pick never saved), 'groupManager' in 2.132.0
    // (the Session Properties toggle never saved), AND 'outputStyle'/'autoResume'
    // in 2.368.0 (the status-bar style pick vanished on resume — FOURTH strike,
    // owner-caught within hours) — keep it in sync with EVERY per-session
    // config writer, and test-auto-resume now pins it.
    for (const k of ['model', 'effort', 'permission', 'account', 'groupManager', 'modelLock', 'lockModel', 'outputStyle']) {
      if (config?.[k]) clean[k] = config[k];
    }
    // autoResume is TRI-STATE: an explicit false must persist (its whole point
    // is that a per-session OFF beats the global default being ON) — the
    // truthy filter above would erase it.
    if (config?.autoResume === true || config?.autoResume === false) clean.autoResume = config.autoResume;
    if (Object.keys(clean).length) this._sessionConfigs[stateKey] = clean;
    else delete this._sessionConfigs[stateKey];
    const legacyId = this._getLegacySessionId(sessionOrKey);
    if (legacyId && legacyId !== stateKey) delete this._sessionConfigs[legacyId];
    this._pushUserState();
  };

  proto.renameSession = async function(sessionOrKey, currentName) {
    const stateKey = this._getSessionStateKey(sessionOrKey);
    const name = await showInputDialog({
      title: tr('Rename Session'), label: tr('Session name'),
      value: this.getCustomName(sessionOrKey) || currentName || '',
      confirmText: tr('Rename'),
    });
    if (name === null) return;
    if (!stateKey) return;
    if (name.trim()) this._customNames[stateKey] = name.trim();
    else delete this._customNames[stateKey];
    const legacyId = this._getLegacySessionId(sessionOrKey);
    if (legacyId && legacyId !== stateKey) delete this._customNames[legacyId];
    this._pushUserState(); this._render();
    const newName = name.trim() || currentName || (legacyId ? legacyId.substring(0, 12) + '...' : tr('Session'));
    // Write the new name back into the AGENT's own store only where the
    // harness HAS one (§2.13 `renameWriteback` — codex's thread name; claude's
    // JSONL carries no title, so a rename stays ours). This is the TRIGGER half
    // of the capability and the ws case is the action half (ws-handler.js
    // `rename-session`, which also writes session.name + session-meta and
    // broadcasts): both must read the same row, or the first harness whose row
    // flips to true gets a server ready to write and a client that never asks
    // — the mirror image of the round-2 fork defect (button on caps, handler on
    // an id). Never a backend id.
    if (backendFeatureCaps(sessionOrKey?.backend).renameWriteback && name.trim()) this.app.renameBackendSession?.(sessionOrKey, name.trim());
    this.app.syncSessionName(sessionOrKey, newName);
  };

}
